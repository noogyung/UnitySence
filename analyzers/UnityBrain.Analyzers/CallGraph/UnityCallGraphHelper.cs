using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace UnityBrain.Analyzers.CallGraph;

public sealed record CriticalMethodInfo(IMethodSymbol Method, bool IsRoot, string CallChain);

public static class UnityCallGraphHelper
{
    private static readonly string[] DefaultCriticalRoots =
    [
        "Update",
        "FixedUpdate",
        "LateUpdate",
        "OnGUI",
        "OnAnimatorIK",
        "OnAnimatorMove",
        "OnRenderObject",
        "OnPostRender",
        "OnPreRender",
    ];

    public static HashSet<string> LoadPerformanceCriticalRootNames(ImmutableArray<AdditionalText> additionalFiles)
    {
        var roots = new HashSet<string>(DefaultCriticalRoots, StringComparer.Ordinal);
        foreach (var file in additionalFiles)
        {
            if (!file.Path.EndsWith("unity-api.json", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var txt = file.GetText()?.ToString();
            if (string.IsNullOrWhiteSpace(txt)) continue;
            try
            {
                using var doc = JsonDocument.Parse(txt);
                if (!doc.RootElement.TryGetProperty("types", out var typesEl) ||
                    typesEl.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }
                foreach (var typeEl in typesEl.EnumerateArray())
                {
                    if (!typeEl.TryGetProperty("events", out var eventsEl) ||
                        eventsEl.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }
                    foreach (var evEl in eventsEl.EnumerateArray())
                    {
                        if (evEl.TryGetProperty("isPerformanceCritical", out var pcEl) &&
                            pcEl.ValueKind == JsonValueKind.True &&
                            evEl.TryGetProperty("name", out var nameEl))
                        {
                            var name = nameEl.GetString();
                            if (!string.IsNullOrEmpty(name))
                            {
                                roots.Add(name!);
                            }
                        }
                    }
                }
            }
            catch
            {
                // Ignore malformed optional unity-api.json
            }
        }
        return roots;
    }

    public static bool DerivesFromUnityBehaviour(INamedTypeSymbol type)
    {
        for (var cur = type.BaseType; cur != null; cur = cur.BaseType)
        {
            var fullName = cur.ToDisplayString();
            if (fullName == "UnityEngine.MonoBehaviour" ||
                fullName == "UnityEngine.Behaviour" ||
                fullName == "UnityEngine.ScriptableObject" ||
                fullName == "Unity.Netcode.NetworkBehaviour")
            {
                return true;
            }
        }
        return false;
    }

    public static Dictionary<IMethodSymbol, CriticalMethodInfo> BuildCriticalMethodMap(
        INamedTypeSymbol typeSymbol,
        Compilation compilation,
        HashSet<string> criticalRoots)
    {
        var result = new Dictionary<IMethodSymbol, CriticalMethodInfo>(SymbolEqualityComparer.Default);
        var adjacency = new Dictionary<IMethodSymbol, HashSet<IMethodSymbol>>(SymbolEqualityComparer.Default);
        var methods = typeSymbol.GetMembers()
            .OfType<IMethodSymbol>()
            .Where(m => m.MethodKind == MethodKind.Ordinary)
            .ToList();

        foreach (var method in methods)
        {
            var callees = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
            foreach (var syntaxRef in method.DeclaringSyntaxReferences)
            {
                var node = syntaxRef.GetSyntax();
                var model = compilation.GetSemanticModel(node.SyntaxTree);
                foreach (var inv in node.DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    if (model.GetSymbolInfo(inv).Symbol is IMethodSymbol target &&
                        SymbolEqualityComparer.Default.Equals(target.ContainingType, typeSymbol))
                    {
                        callees.Add(target.OriginalDefinition);
                    }
                }
            }
            adjacency[method] = callees;
        }

        var queue = new Queue<CriticalMethodInfo>();
        foreach (var method in methods)
        {
            if (criticalRoots.Contains(method.Name))
            {
                var info = new CriticalMethodInfo(method, true, $"{method.Name}()");
                result[method] = info;
                queue.Enqueue(info);
            }
        }

        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            if (!adjacency.TryGetValue(current.Method, out var neighbors)) continue;
            foreach (var next in neighbors)
            {
                if (result.ContainsKey(next)) continue;
                var info = new CriticalMethodInfo(next, false, $"{current.CallChain} -> {next.Name}()");
                result[next] = info;
                queue.Enqueue(info);
            }
        }

        return result;
    }
}
