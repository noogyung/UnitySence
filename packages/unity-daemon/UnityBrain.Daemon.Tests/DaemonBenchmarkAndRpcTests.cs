using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using UnityBrain.Daemon.Cache;

namespace UnityBrain.Daemon.Tests;

public sealed class DaemonBenchmarkAndRpcTests
{
    private const string PlayerScriptGuid = "11223344556677889900aabbccddeeff";

    [Fact]
    public void BenchmarksThousandAssetColdIndexUnder500MsAndIncrementalWarmReloadUnder150Ms()
    {
        string tempRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "test-output",
            "daemon-bench-" + Guid.NewGuid().ToString("N"));
        string prefabsDir = Path.Combine(tempRoot, "Assets", "Prefabs");
        string cacheFile = Path.Combine(tempRoot, "Library", "UnityBrainCache", "asset-index.bin");
        Directory.CreateDirectory(prefabsDir);

        try
        {
            for (int i = 0; i < 1000; i++)
            {
                string prefabPath = Path.Combine(prefabsDir, $"Enemy_{i:D4}.prefab");
                string metaPath = prefabPath + ".meta";
                string assetGuid = $"aa00000000000000000000000000{i:D4}";

                File.WriteAllText(
                    metaPath,
                    $"fileFormatVersion: 2\nguid: {assetGuid}\nPrefabImporter:\n");

                File.WriteAllText(
                    prefabPath,
                    $@"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1000
GameObject:
  m_ObjectHideFlags: 0
  m_Name: Enemy_{i:D4}
--- !u!4 &1001
Transform:
  m_GameObject: {{fileID: 1000}}
  m_Father: {{fileID: 0}}
--- !u!114 &1002
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {{fileID: 1000}}
  m_Enabled: 1
  m_Script: {{fileID: 11500000, guid: {PlayerScriptGuid}, type: 3}}
  moveSpeed: {5.0 + (i % 10)}
  maxHealth: {100 + i}
");
            }

            // JIT warmup on a throwaway instance (real daemon stays resident, benchmark measures steady-state indexing)
            var warmup = new BinaryIndexCache();
            warmup.BuildOrUpdateIndex(tempRoot, Path.Combine(tempRoot, "Library", "UnityBrainCache", "warmup.bin"), forceRebuild: true);

            var coldCache = new BinaryIndexCache();
            var coldSw = Stopwatch.StartNew();
            var coldRes = coldCache.BuildOrUpdateIndex(tempRoot, cacheFile, forceRebuild: true);
            coldSw.Stop();

            Console.WriteLine($"    [Benchmark] 1,000-asset cold index: {coldSw.Elapsed.TotalMilliseconds:F1} ms");
            AssertEx.Equal(1000, coldRes.IndexedAssets);
            AssertEx.Equal(1000, coldCache.FindByScriptGuid(PlayerScriptGuid).Count);
            AssertEx.True(
                coldSw.Elapsed.TotalMilliseconds < 500.0,
                $"Cold index took {coldSw.Elapsed.TotalMilliseconds:F1} ms (limit < 500 ms)");

            // Modify 1 file and reload from binary cache on a brand-new BinaryIndexCache instance
            string modifiedPrefab = Path.Combine(prefabsDir, "Enemy_0042.prefab");
            string updatedContent = File.ReadAllText(modifiedPrefab).Replace("moveSpeed: 7", "moveSpeed: 99.5");
            File.WriteAllText(modifiedPrefab, updatedContent);
            File.SetLastWriteTimeUtc(modifiedPrefab, DateTime.UtcNow.AddSeconds(2));

            var warmCache = new BinaryIndexCache();
            var warmSw = Stopwatch.StartNew();
            var warmRes = warmCache.BuildOrUpdateIndex(tempRoot, cacheFile, forceRebuild: false);
            warmSw.Stop();

            Console.WriteLine($"    [Benchmark] 1-file incremental warm reload: {warmSw.Elapsed.TotalMilliseconds:F1} ms");
            AssertEx.Equal(1000, warmRes.IndexedAssets);
            AssertEx.True(
                warmSw.Elapsed.TotalMilliseconds < 150.0,
                $"Incremental reload took {warmSw.Elapsed.TotalMilliseconds:F1} ms (limit < 150 ms)");

            var enemy42Values = warmCache.GetSerializedValues(PlayerScriptGuid, "moveSpeed")
                .Where(v => v.AssetPath.EndsWith("Enemy_0042.prefab", StringComparison.Ordinal))
                .ToList();
            AssertEx.Equal(1, enemy42Values.Count);
            AssertEx.Equal("99.5", enemy42Values[0].Value);
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
    public async Task HandlesAllJsonRpcMethodsOverContentLengthFraming()
    {
        string tempRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "test-output",
            "daemon-rpc-" + Guid.NewGuid().ToString("N"));
        string scenesDir = Path.Combine(tempRoot, "Assets", "Scenes");
        string cacheFile = Path.Combine(tempRoot, "Library", "UnityBrainCache", "asset-index.bin");
        Directory.CreateDirectory(scenesDir);

        try
        {
            string scenePath = Path.Combine(scenesDir, "Battle.unity");
            File.WriteAllText(scenePath + ".meta", "fileFormatVersion: 2\nguid: abcdefabcdefabcdefabcdefabcdef12\n");
            File.WriteAllText(scenePath, $@"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &10
GameObject:
  m_ObjectHideFlags: 0
  m_Name: PlayerHero
--- !u!4 &11
Transform:
  m_GameObject: {{fileID: 10}}
  m_Father: {{fileID: 0}}
--- !u!114 &12
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {{fileID: 10}}
  m_Script: {{fileID: 11500000, guid: {PlayerScriptGuid}, type: 3}}
  moveSpeed: 6.25
--- !u!114 &13
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_GameObject: {{fileID: 10}}
  m_Script: {{fileID: 11500000, guid: 99999999999999999999999999999999, type: 3}}
  m_OnClick:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {{fileID: 12}}
        m_TargetAssemblyTypeName: PlayerController, Assembly-CSharp
        m_MethodName: OnJumpPressed
        m_Mode: 1
");

            var cache = new BinaryIndexCache();
            cache.BuildOrUpdateIndex(tempRoot, cacheFile, forceRebuild: true);
            var server = new RpcServer(cache, tempRoot, cacheFile);

            using var input = new MemoryStream();
            void EnqueueRequest(int id, string method, object? @params = null)
            {
                byte[] frame = RpcServer.EncodeFrame(new
                {
                    jsonrpc = "2.0",
                    id,
                    method,
                    @params = @params ?? new { },
                });
                input.Write(frame, 0, frame.Length);
            }

            EnqueueRequest(1, "index/status");
            EnqueueRequest(2, "usage/findByScriptGuid", new { scriptGuid = PlayerScriptGuid });
            EnqueueRequest(3, "usage/findByMethod", new { scriptGuid = PlayerScriptGuid, className = "PlayerController", methodName = "OnJumpPressed" });
            EnqueueRequest(4, "inspector/getSerializedValues", new { scriptGuid = PlayerScriptGuid, fieldName = "moveSpeed" });
            EnqueueRequest(5, "index/rebuild", new { force = true });
            EnqueueRequest(6, "shutdown");
            input.Position = 0;

            using var output = new MemoryStream();
            await server.RunAsync(input, output).ConfigureAwait(false);
            output.Position = 0;

            var responses = new Dictionary<long, JsonElement>();
            while (true)
            {
                var frame = await RpcServer.ReadFrameAsync(output, default).ConfigureAwait(false);
                if (frame == null) break;
                using var doc = JsonDocument.Parse(frame);
                long id = doc.RootElement.GetProperty("id").GetInt64();
                responses[id] = doc.RootElement.Clone();
            }

            AssertEx.Equal(6, responses.Count);
            AssertEx.Equal("ready", responses[1].GetProperty("result").GetProperty("state").GetString());
            AssertEx.Equal(1, responses[1].GetProperty("result").GetProperty("indexedAssets").GetInt32());

            var scriptLocs = responses[2].GetProperty("result").GetProperty("locations");
            AssertEx.Equal(1, scriptLocs.GetArrayLength());
            AssertEx.Equal("PlayerHero", scriptLocs[0].GetProperty("gameObjectPath").GetString());

            var methodLocs = responses[3].GetProperty("result").GetProperty("locations");
            AssertEx.Equal(1, methodLocs.GetArrayLength());
            AssertEx.Equal("unityEventCallback", methodLocs[0].GetProperty("usageKind").GetString());
            AssertEx.Equal("OnJumpPressed", methodLocs[0].GetProperty("methodName").GetString());

            var fields = responses[4].GetProperty("result").GetProperty("fields");
            AssertEx.Equal(1, fields.GetArrayLength());
            AssertEx.Equal("6.25", fields[0].GetProperty("value").GetString());

            AssertEx.Equal(1, responses[5].GetProperty("result").GetProperty("indexedAssets").GetInt32());
            AssertEx.True(responses[6].GetProperty("result").GetProperty("ok").GetBoolean());
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
    public void ResolvesPrefabInstanceModificationsAcrossPrefabAndSceneAssets()
    {
        string tempRoot = Path.Combine(
            Directory.GetCurrentDirectory(),
            "test-output",
            "daemon-prefab-override-" + Guid.NewGuid().ToString("N"));
        string prefabsDir = Path.Combine(tempRoot, "Assets", "Prefabs");
        string scenesDir = Path.Combine(tempRoot, "Assets", "Scenes");
        string cacheFile = Path.Combine(tempRoot, "Library", "UnityBrainCache", "asset-index.bin");
        Directory.CreateDirectory(prefabsDir);
        Directory.CreateDirectory(scenesDir);

        try
        {
            const string prefabAssetGuid = "abcdef0123456789abcdef0123456789";
            const string sceneAssetGuid = "fedcba9876543210fedcba9876543210";

            File.WriteAllText(
                Path.Combine(prefabsDir, "Hero.prefab.meta"),
                $"fileFormatVersion: 2\nguid: {prefabAssetGuid}\n");
            File.WriteAllText(
                Path.Combine(prefabsDir, "Hero.prefab"),
                $@"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &10
GameObject:
  m_Name: Hero
--- !u!4 &11
Transform:
  m_GameObject: {{fileID: 10}}
  m_Father: {{fileID: 0}}
--- !u!114 &11400002
MonoBehaviour:
  m_GameObject: {{fileID: 10}}
  m_Script: {{fileID: 11500000, guid: {PlayerScriptGuid}, type: 3}}
  moveSpeed: 5
");

            File.WriteAllText(
                Path.Combine(scenesDir, "BossArena.unity.meta"),
                $"fileFormatVersion: 2\nguid: {sceneAssetGuid}\n");
            File.WriteAllText(
                Path.Combine(scenesDir, "BossArena.unity"),
                $@"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1001 &9000
PrefabInstance:
  m_TransformParent: {{fileID: 0}}
  m_Modification:
    m_Modifications:
    - target: {{fileID: 11400002, guid: {prefabAssetGuid}, type: 3}}
      propertyPath: moveSpeed
      value: 19.5
");

            var cache = new BinaryIndexCache();
            cache.BuildOrUpdateIndex(tempRoot, cacheFile, forceRebuild: true);

            var usages = cache.FindByScriptGuid(PlayerScriptGuid);
            AssertEx.True(usages.Any(u => u.UsageKind == "prefabOverride" && u.AssetPath.EndsWith("BossArena.unity")));

            var values = cache.GetSerializedValues(PlayerScriptGuid, "moveSpeed");
            AssertEx.True(values.Any(v => v.Value == "19.5" && v.AssetPath.EndsWith("BossArena.unity")));
        }
        finally
        {
            if (Directory.Exists(tempRoot))
            {
                Directory.Delete(tempRoot, recursive: true);
            }
        }
    }
}
