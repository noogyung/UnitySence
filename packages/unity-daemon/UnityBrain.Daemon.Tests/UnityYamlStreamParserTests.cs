using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using UnityBrain.Daemon.Indexing;

namespace UnityBrain.Daemon.Tests;

[AttributeUsage(AttributeTargets.Method)]
public sealed class FactAttribute : Attribute
{
}

public static class AssertEx
{
    public static void True(bool condition, string message = "Expected true")
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    public static void Equal<T>(T expected, T actual, string? message = null)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException(
                message ?? $"Expected <{expected}>, got <{actual}>.");
        }
    }
}

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var filter = args.Length > 0 && !string.IsNullOrWhiteSpace(args[0]) ? args[0] : null;
        var asm = Assembly.GetExecutingAssembly();
        int passed = 0;
        int failed = 0;

        foreach (var type in asm.GetTypes().OrderBy(t => t.Name))
        {
            var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => m.GetCustomAttribute<FactAttribute>() != null)
                .ToList();
            if (methods.Count == 0) continue;

            foreach (var method in methods)
            {
                var fullName = $"{type.Name}.{method.Name}";
                if (filter != null &&
                    !fullName.Contains(filter, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    var instance = Activator.CreateInstance(type)!;
                    var result = method.Invoke(instance, null);
                    if (result is Task task)
                    {
                        await task.ConfigureAwait(false);
                    }
                    Console.WriteLine($"  PASS {fullName}");
                    passed++;
                }
                catch (Exception ex)
                {
                    var inner = ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                    Console.Error.WriteLine($"  FAIL {fullName}: {inner.Message}");
                    failed++;
                }
            }
        }

        Console.WriteLine($"Daemon Test Summary: {passed} passed, {failed} failed.");
        return failed > 0 ? 1 : 0;
    }
}

public sealed class UnityYamlStreamParserTests
{
    [Fact]
    public void ParsesGameObjectHierarchyComponentsSerializedFieldsAndUnityEventCallbacks()
    {
        const string sceneYaml = @"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  m_Name: Canvas
--- !u!224 &101
RectTransform:
  m_GameObject: {fileID: 100}
  m_Father: {fileID: 0}
--- !u!1 &200
GameObject:
  m_ObjectHideFlags: 0
  m_Name: Panel
--- !u!224 &201
RectTransform:
  m_GameObject: {fileID: 200}
  m_Father: {fileID: 101}
--- !u!1 &300
GameObject:
  m_ObjectHideFlags: 0
  m_Name: StartButton
--- !u!224 &301
RectTransform:
  m_GameObject: {fileID: 300}
  m_Father: {fileID: 201}
--- !u!114 &400
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
  moveSpeed: 8.5
  maxHealth: 250
--- !u!114 &500
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: 300}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
  m_OnClick:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 400}
        m_TargetAssemblyTypeName: Game.PlayerController, Assembly-CSharp
        m_MethodName: OnStartButtonClicked
        m_Mode: 1
--- !u!1001 &600
PrefabInstance:
  m_ObjectHideFlags: 0
  m_Modification:
    m_TransformParent: {fileID: 201}
    m_Modifications:
    - target: {fileID: 9001, guid: cccccccccccccccccccccccccccccccc, type: 3}
      propertyPath: moveSpeed
      value: 14.2
      objectReference: {fileID: 0}
";

        var index = UnityYamlStreamParser.ParseText(
            sceneYaml,
            "Assets/Scenes/MainMenu.unity",
            "1234567890abcdef1234567890abcdef");

        AssertEx.Equal("scene", index.AssetType);
        AssertEx.Equal(3, index.ComponentUsages.Count);

        var playerComp = index.ComponentUsages.First(c => c.ScriptGuid == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        AssertEx.Equal("Canvas", playerComp.GameObjectPath);
        AssertEx.Equal("8.5", playerComp.SerializedValues["moveSpeed"]);
        AssertEx.Equal("250", playerComp.SerializedValues["maxHealth"]);

        AssertEx.Equal(1, index.EventCallbacks.Count);
        var cb = index.EventCallbacks[0];
        AssertEx.Equal("Canvas/Panel/StartButton", cb.GameObjectPath);
        AssertEx.Equal("OnStartButtonClicked", cb.MethodName);
        AssertEx.Equal("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", cb.TargetScriptGuid);
        AssertEx.Equal("PlayerController", cb.TargetTypeName);

        var prefabOverride = index.ComponentUsages.First(c => c.UsageKind == "prefabOverride");
        AssertEx.Equal("Canvas/Panel (PrefabOverride)", prefabOverride.GameObjectPath);
        AssertEx.Equal("14.2", prefabOverride.SerializedValues["moveSpeed"]);
    }

    [Fact]
    public void MetaGuidMapScansBidirectionallyAndHandlesIncrementalUpdates()
    {
        string tempRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "test-output",
            "daemon-metaguid-" + Guid.NewGuid().ToString("N"));
        string scriptsDir = Path.Combine(tempRoot, "Assets", "Scripts");
        Directory.CreateDirectory(scriptsDir);

        try
        {
            string csPath = Path.Combine(scriptsDir, "EnemyAI.cs");
            string metaPath = csPath + ".meta";
            File.WriteAllText(csPath, "public class EnemyAI {}");
            File.WriteAllText(metaPath, "fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\nMonoImporter:\n");

            var map = new MetaGuidMap();
            map.Rebuild(tempRoot);

            AssertEx.Equal(1, map.Count);
            AssertEx.True(map.TryGetAssetPath("0123456789abcdef0123456789abcdef", out var resolvedPath));
            AssertEx.Equal("Assets/Scripts/EnemyAI.cs", resolvedPath);
            AssertEx.True(map.TryGetGuid("Assets/Scripts/EnemyAI.cs", out var resolvedGuid));
            AssertEx.Equal("0123456789abcdef0123456789abcdef", resolvedGuid);

            // Incremental deletion removes mapping
            File.Delete(metaPath);
            AssertEx.True(map.UpdateMetaFile(tempRoot, metaPath));
            AssertEx.Equal(0, map.Count);
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, recursive: true);
            }
        }
    }

    [Fact]
    public void ParsesScriptableObjectAssetWithoutGameObjectAndSkipsBinaryYaml()
    {
        const string scriptableYaml = @"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_Script: {fileID: 11500000, guid: dddddddddddddddddddddddddddddddd, type: 3}
  m_Name: WeaponStats_Sword
  damage: 42
  critChance: 0.25
";

        var soIndex = UnityYamlStreamParser.ParseText(
            scriptableYaml,
            "Assets/Data/WeaponStats_Sword.asset",
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

        AssertEx.Equal("asset", soIndex.AssetType);
        AssertEx.Equal(1, soIndex.ComponentUsages.Count);
        AssertEx.Equal("WeaponStats_Sword", soIndex.ComponentUsages[0].GameObjectPath);
        AssertEx.Equal("42", soIndex.ComponentUsages[0].SerializedValues["damage"]);

        var binIndex = UnityYamlStreamParser.ParseText(
            "\0\u0001BINARY_UNITY_ASSET\nnot yaml",
            "Assets/Models/Mesh.asset",
            "ffffffffffffffffffffffffffffffff");
        AssertEx.Equal(0, binIndex.ComponentUsages.Count);
        AssertEx.Equal(0, binIndex.EventCallbacks.Count);
    }

    [Fact]
    public void SummarizesSerializedArrayListsAsItemCounts()
    {
        const string yaml = @"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: dddddddddddddddddddddddddddddddd, type: 3}
  m_Name: PatrolPath
  waypoints:
  - {x: 0, y: 0, z: 0}
  - {x: 5, y: 0, z: 5}
  emptyTags: []
  patrolSpeed: 4.5
";
        var idx = UnityYamlStreamParser.ParseText(yaml, "Assets/Data/PatrolPath.asset", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        AssertEx.Equal("[2 items]", idx.ComponentUsages[0].SerializedValues["waypoints"]);
        AssertEx.Equal("[0 items]", idx.ComponentUsages[0].SerializedValues["emptyTags"]);
        AssertEx.Equal("4.5", idx.ComponentUsages[0].SerializedValues["patrolSpeed"]);
    }
}
