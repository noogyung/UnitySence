using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using UnityBrain.Analyzers.Json;

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

    public static HashSet<string> LoadPerformanceCriticalRootNames(
        ImmutableArray<AdditionalText> additionalFiles,
        CancellationToken cancellationToken = default)
    {
        var roots = new HashSet<string>(DefaultCriticalRoots, StringComparer.Ordinal);
        foreach (var file in additionalFiles)
        {
            if (!file.Path.EndsWith("unity-api.json", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var txt = file.GetText(cancellationToken)?.ToString();
            if (string.IsNullOrWhiteSpace(txt)) continue;
            try
            {
                if (SimpleJson.Parse(txt!) is not Dictionary<string, object?> rootObj ||
                    !rootObj.TryGetValue("types", out var typesRaw) ||
                    typesRaw is not List<object?> typesList)
                {
                    continue;
                }
                foreach (var typeItem in typesList)
                {
                    if (typeItem is not Dictionary<string, object?> typeObj ||
                        !typeObj.TryGetValue("events", out var eventsRaw) ||
                        eventsRaw is not List<object?> eventsList)
                    {
                        continue;
                    }
                    foreach (var evItem in eventsList)
                    {
                        if (evItem is Dictionary<string, object?> evObj &&
                            evObj.TryGetValue("isPerformanceCritical", out var pcVal) &&
                            pcVal is true &&
                            evObj.TryGetValue("name", out var nameVal) &&
                            nameVal is string name &&
                            !string.IsNullOrEmpty(name))
                        {
                            roots.Add(name);
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
                fullName == "Unity.Netcode.NetworkBehaviour" ||
                fullName == "UnityEngine.StateMachineBehaviour" ||
                fullName == "UnityEditor.Editor" ||
                fullName == "UnityEditor.EditorWindow" ||
                fullName == "UnityEditor.PropertyDrawer" ||
                fullName == "UnityEditor.AssetImporters.ScriptedImporter" ||
                fullName == "UnityEngine.EventSystems.UIBehaviour")
            {
                return true;
            }
        }
        return false;
    }

    public static bool HasPerFrameLifecycleCallbacks(INamedTypeSymbol type)
    {
        for (var cur = type.BaseType; cur != null; cur = cur.BaseType)
        {
            var fullName = cur.ToDisplayString();
            if (fullName == "UnityEngine.MonoBehaviour" ||
                fullName == "Unity.Netcode.NetworkBehaviour" ||
                fullName == "UnityEngine.StateMachineBehaviour" ||
                fullName == "UnityEditor.Editor" ||
                fullName == "UnityEditor.EditorWindow" ||
                fullName == "UnityEditor.PropertyDrawer" ||
                fullName == "UnityEngine.EventSystems.UIBehaviour")
            {
                return true;
            }
        }
        return false;
    }

    public static bool IsValidUnityCriticalRoot(IMethodSymbol method, HashSet<string> criticalRoots)
    {
        if (method.IsStatic || method.MethodKind != MethodKind.Ordinary)
        {
            return false;
        }
        if (!criticalRoots.Contains(method.Name))
        {
            return false;
        }
        if (method.Name == "OnAnimatorIK")
        {
            return method.Parameters.Length == 1 &&
                   method.Parameters[0].Type.SpecialType == SpecialType.System_Int32;
        }
        if (method.Name == "OnGUI")
        {
            return method.Parameters.Length == 0 || method.Parameters.Length == 2 || method.Parameters.Length == 3;
        }
        return method.Parameters.Length == 0;
    }

    public static IEnumerable<SyntaxNode> EnumerateDirectBodyNodes(SyntaxNode methodSyntax)
    {
        var stack = new Stack<SyntaxNode>();
        foreach (var child in methodSyntax.ChildNodes().Reverse())
        {
            stack.Push(child);
        }
        while (stack.Count > 0)
        {
            var cur = stack.Pop();
            if (cur is AnonymousFunctionExpressionSyntax || cur is LocalFunctionStatementSyntax)
            {
                continue;
            }
            yield return cur;
            foreach (var child in cur.ChildNodes().Reverse())
            {
                stack.Push(child);
            }
        }
    }

    public static Dictionary<IMethodSymbol, CriticalMethodInfo> BuildCriticalMethodMap(
        INamedTypeSymbol typeSymbol,
        Compilation compilation,
        HashSet<string> criticalRoots,
        CancellationToken cancellationToken = default)
    {
        var result = new Dictionary<IMethodSymbol, CriticalMethodInfo>(SymbolEqualityComparer.Default);
        if (!HasPerFrameLifecycleCallbacks(typeSymbol))
        {
            return result;
        }

        var adjacency = new Dictionary<IMethodSymbol, HashSet<IMethodSymbol>>(SymbolEqualityComparer.Default);
        var typeAndBaseMethods = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
        var methods = typeSymbol.GetMembers()
            .OfType<IMethodSymbol>()
            .Where(m => !m.IsImplicitlyDeclared &&
                        (m.MethodKind == MethodKind.Ordinary || m.MethodKind == MethodKind.PropertyGet))
            .ToList();

        foreach (var m in methods)
        {
            typeAndBaseMethods.Add(m.OriginalDefinition);
        }

        void CollectCalleesForMethod(IMethodSymbol method)
        {
            if (adjacency.ContainsKey(method)) return;
            var callees = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
            adjacency[method] = callees;

            foreach (var syntaxRef in method.DeclaringSyntaxReferences)
            {
                var node = syntaxRef.GetSyntax(cancellationToken);
                if (node is TypeDeclarationSyntax) continue;
                var model = compilation.GetSemanticModel(node.SyntaxTree);
                foreach (var childNode in EnumerateDirectBodyNodes(node))
                {
                    if (childNode is InvocationExpressionSyntax inv &&
                        model.GetSymbolInfo(inv, cancellationToken).Symbol is IMethodSymbol target &&
                        IsSameHierarchyMethod(typeSymbol, target))
                    {
                        var orig = target.OriginalDefinition;
                        callees.Add(orig);
                    }
                    else if (childNode is IdentifierNameSyntax or MemberAccessExpressionSyntax)
                    {
                        if (model.GetSymbolInfo(childNode, cancellationToken).Symbol is IPropertySymbol prop &&
                            prop.GetMethod != null &&
                            IsSameHierarchyMethod(typeSymbol, prop.GetMethod))
                        {
                            callees.Add(prop.GetMethod.OriginalDefinition);
                        }
                    }
                }
            }
        }

        foreach (var method in methods)
        {
            CollectCalleesForMethod(method);
        }

        var queue = new Queue<CriticalMethodInfo>();
        foreach (var method in methods)
        {
            if (IsValidUnityCriticalRoot(method, criticalRoots))
            {
                var info = new CriticalMethodInfo(method, true, $"{method.Name}()");
                result[method] = info;
                queue.Enqueue(info);
            }
        }

        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            if (!adjacency.TryGetValue(current.Method, out var neighbors))
            {
                CollectCalleesForMethod(current.Method);
                if (!adjacency.TryGetValue(current.Method, out neighbors)) continue;
            }
            foreach (var next in neighbors)
            {
                if (result.ContainsKey(next)) continue;
                if (!adjacency.ContainsKey(next))
                {
                    CollectCalleesForMethod(next);
                }
                string label = next.MethodKind == MethodKind.PropertyGet && next.AssociatedSymbol != null
                    ? next.AssociatedSymbol.Name
                    : $"{next.Name}()";
                var info = new CriticalMethodInfo(next, false, $"{current.CallChain} -> {label}");
                result[next] = info;
                queue.Enqueue(info);
            }
        }

        return result;
    }

    private static bool IsSameHierarchyMethod(INamedTypeSymbol typeSymbol, IMethodSymbol target)
    {
        for (var cur = typeSymbol; cur != null; cur = cur.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(cur, target.ContainingType))
            {
                return true;
            }
        }
        return false;
    }
}
