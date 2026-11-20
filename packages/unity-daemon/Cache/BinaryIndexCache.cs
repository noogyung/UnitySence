using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using UnityBrain.Daemon.Indexing;

namespace UnityBrain.Daemon.Cache;

public sealed record AssetUsageLocationDto(
    string AssetPath,
    string AssetType,
    string AssetGuid,
    string GameObjectPath,
    string FileId,
    int Line,
    string UsageKind,
    string? MethodName = null,
    IReadOnlyDictionary<string, string>? SerializedValues = null);

public sealed record SerializedFieldValueEntryDto(
    string FieldName,
    string Value,
    string AssetPath,
    string AssetType,
    string GameObjectPath,
    string FileId,
    int Line);

public sealed record IndexStatusDto(
    string State,
    int IndexedAssets,
    int IndexedMetas,
    double LastBuildMs);

public sealed record IndexRebuildResultDto(
    int IndexedAssets,
    double ElapsedMs);

public sealed class BinaryIndexCache
{
    private const uint MagicHeader = 0x58494255; // "UBIX" little-endian
    private const uint FormatVersion = 1;

    private readonly object _stateLock = new();
    private readonly MetaGuidMap _metaMap = new();
    private Dictionary<string, CachedAssetEntry> _assetEntries = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, CachedMetaEntry> _metaEntries = new(StringComparer.OrdinalIgnoreCase);

    private Dictionary<string, List<AssetUsageLocationDto>> _usagesByScriptGuid = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, List<(string TargetScriptGuid, string TargetTypeName, AssetUsageLocationDto Location)>> _callbacksByMethod = new(StringComparer.Ordinal);
    private Dictionary<string, List<SerializedFieldValueEntryDto>> _fieldsByScriptGuid = new(StringComparer.OrdinalIgnoreCase);

    private string _state = "idle";
    private double _lastBuildMs;

    private sealed record CachedMetaEntry(
        string MetaRelPath,
        long LastWriteUtcTicks,
        long Length,
        string Guid,
        string AssetRelPath);

    private sealed record CachedAssetEntry(
        string AssetPath,
        long LastWriteUtcTicks,
        long Length,
        AssetDocumentIndex Document);

    public IndexStatusDto GetStatus()
    {
        lock (_stateLock)
        {
            return new IndexStatusDto(
                _state,
                _assetEntries.Count,
                _metaMap.Count,
                _lastBuildMs);
        }
    }

    public IndexRebuildResultDto BuildOrUpdateIndex(string projectRoot, string cacheFilePath, bool forceRebuild = false)
    {
        var sw = Stopwatch.StartNew();

        lock (_stateLock)
        {
            _state = "indexing";
        }

        try
        {
            if (!forceRebuild && File.Exists(cacheFilePath))
            {
                TryLoadFromBinary(cacheFilePath);
            }
            else if (forceRebuild)
            {
                lock (_stateLock)
                {
                    _assetEntries.Clear();
                    _metaEntries.Clear();
                    _metaMap.Clear();
                }
            }

            var diskMetas = new List<(string FullPath, string RelPath, long Ticks, long Length)>();
            var diskAssets = new List<(string FullPath, string RelPath, long Ticks, long Length)>();
            var scanRoots = new[]
            {
                Path.Combine(projectRoot, "Assets"),
                Path.Combine(projectRoot, "Packages"),
            };

            var opts = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true,
                AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
            };

            foreach (var scanDir in scanRoots)
            {
                if (!Directory.Exists(scanDir)) continue;
                var dirInfo = new DirectoryInfo(scanDir);
                foreach (var fileInfo in dirInfo.EnumerateFiles("*", opts))
                {
                    string name = fileInfo.Name;
                    if (name.EndsWith(".meta", StringComparison.OrdinalIgnoreCase))
                    {
                        string rel = Path.GetRelativePath(projectRoot, fileInfo.FullName).Replace('\\', '/');
                        diskMetas.Add((fileInfo.FullName, rel, fileInfo.LastWriteTimeUtc.Ticks, fileInfo.Length));
                    }
                    else if (IsIndexableYamlAsset(name))
                    {
                        string rel = Path.GetRelativePath(projectRoot, fileInfo.FullName).Replace('\\', '/');
                        diskAssets.Add((fileInfo.FullName, rel, fileInfo.LastWriteTimeUtc.Ticks, fileInfo.Length));
                    }
                }
            }

            Dictionary<string, CachedMetaEntry> prevMetas;
            Dictionary<string, CachedAssetEntry> prevAssets;
            lock (_stateLock)
            {
                prevMetas = new Dictionary<string, CachedMetaEntry>(_metaEntries, StringComparer.OrdinalIgnoreCase);
                prevAssets = new Dictionary<string, CachedAssetEntry>(_assetEntries, StringComparer.OrdinalIgnoreCase);
            }

            // 1. Incremental .meta update
            var nextMetas = new Dictionary<string, CachedMetaEntry>(diskMetas.Count, StringComparer.OrdinalIgnoreCase);
            var dirtyMetas = new List<(string FullPath, string RelPath, long Ticks, long Length)>();

            foreach (var m in diskMetas)
            {
                if (!forceRebuild &&
                    prevMetas.TryGetValue(m.RelPath, out var cachedMeta) &&
                    cachedMeta.LastWriteUtcTicks == m.Ticks &&
                    cachedMeta.Length == m.Length)
                {
                    nextMetas[m.RelPath] = cachedMeta;
                }
                else
                {
                    dirtyMetas.Add(m);
                }
            }

            if (dirtyMetas.Count > 0)
            {
                var parsedMetas = new ConcurrentBag<CachedMetaEntry>();
                Parallel.ForEach(dirtyMetas, m =>
                {
                    var guid = MetaGuidMap.TryReadGuidFast(m.FullPath);
                    if (guid != null)
                    {
                        string assetRel = m.RelPath.Substring(0, m.RelPath.Length - ".meta".Length);
                        parsedMetas.Add(new CachedMetaEntry(m.RelPath, m.Ticks, m.Length, guid, assetRel));
                    }
                });

                foreach (var pm in parsedMetas)
                {
                    nextMetas[pm.MetaRelPath] = pm;
                }
            }

            _metaMap.Clear();
            foreach (var me in nextMetas.Values)
            {
                _metaMap.SetMapping(me.Guid, me.AssetRelPath, me.MetaRelPath, new FileStamp(me.LastWriteUtcTicks, me.Length));
            }

            // 2. Incremental YAML asset update
            var nextAssets = new Dictionary<string, CachedAssetEntry>(diskAssets.Count, StringComparer.OrdinalIgnoreCase);
            var dirtyAssets = new List<(string FullPath, string RelPath, long Ticks, long Length, string Guid)>();

            foreach (var a in diskAssets)
            {
                string assetGuid = _metaMap.TryGetGuid(a.RelPath, out var g) ? g : string.Empty;
                if (!forceRebuild &&
                    prevAssets.TryGetValue(a.RelPath, out var cachedAsset) &&
                    cachedAsset.LastWriteUtcTicks == a.Ticks &&
                    cachedAsset.Length == a.Length &&
                    string.Equals(cachedAsset.Document.AssetGuid, assetGuid, StringComparison.OrdinalIgnoreCase))
                {
                    nextAssets[a.RelPath] = cachedAsset;
                }
                else
                {
                    dirtyAssets.Add((a.FullPath, a.RelPath, a.Ticks, a.Length, assetGuid));
                }
            }

            if (dirtyAssets.Count > 0)
            {
                var parsedDocs = new ConcurrentBag<CachedAssetEntry>();
                Parallel.ForEach(dirtyAssets, a =>
                {
                    var doc = UnityYamlStreamParser.ParseFile(a.FullPath, a.RelPath, a.Guid);
                    parsedDocs.Add(new CachedAssetEntry(a.RelPath, a.Ticks, a.Length, doc));
                });

                foreach (var pd in parsedDocs)
                {
                    nextAssets[pd.AssetPath] = pd;
                }
            }

            bool cacheDirty = dirtyMetas.Count > 0 ||
                              dirtyAssets.Count > 0 ||
                              nextMetas.Count != prevMetas.Count ||
                              nextAssets.Count != prevAssets.Count ||
                              !File.Exists(cacheFilePath);

            // 3. Build fast lookup tables + persist binary cache when dirty
            BuildLookupTables(nextAssets, nextMetas, sw.Elapsed.TotalMilliseconds);

            if (cacheDirty)
            {
                SaveToBinary(cacheFilePath, nextMetas, nextAssets);
            }

            sw.Stop();
            lock (_stateLock)
            {
                _lastBuildMs = Math.Round(sw.Elapsed.TotalMilliseconds, 3);
                _state = "ready";
            }

            return new IndexRebuildResultDto(nextAssets.Count, Math.Round(sw.Elapsed.TotalMilliseconds, 3));
        }
        catch
        {
            lock (_stateLock)
            {
                _state = "error";
            }
            throw;
        }
    }

    public List<AssetUsageLocationDto> FindByScriptGuid(string scriptGuid)
    {
        if (string.IsNullOrWhiteSpace(scriptGuid)) return new List<AssetUsageLocationDto>();
        lock (_stateLock)
        {
            return _usagesByScriptGuid.TryGetValue(scriptGuid.Trim(), out var list)
                ? new List<AssetUsageLocationDto>(list)
                : new List<AssetUsageLocationDto>();
        }
    }

    public List<AssetUsageLocationDto> FindByMethod(string? scriptGuid, string? className, string methodName)
    {
        if (string.IsNullOrWhiteSpace(methodName)) return new List<AssetUsageLocationDto>();
        string trimmedMethod = methodName.Trim();
        string? trimmedGuid = string.IsNullOrWhiteSpace(scriptGuid) ? null : scriptGuid.Trim();
        string? trimmedClass = string.IsNullOrWhiteSpace(className) ? null : className.Trim();

        var results = new List<AssetUsageLocationDto>();
        lock (_stateLock)
        {
            if (!_callbacksByMethod.TryGetValue(trimmedMethod, out var entries))
            {
                return results;
            }

            foreach (var entry in entries)
            {
                bool guidMatch = trimmedGuid != null &&
                                 !string.IsNullOrEmpty(entry.TargetScriptGuid) &&
                                 string.Equals(entry.TargetScriptGuid, trimmedGuid, StringComparison.OrdinalIgnoreCase);

                bool classMatch = trimmedClass != null &&
                                  !string.IsNullOrEmpty(entry.TargetTypeName) &&
                                  string.Equals(entry.TargetTypeName, trimmedClass, StringComparison.Ordinal);

                if (trimmedGuid == null && trimmedClass == null)
                {
                    results.Add(entry.Location);
                }
                else if (guidMatch || (string.IsNullOrEmpty(entry.TargetScriptGuid) && classMatch) ||
                         (trimmedGuid == null && classMatch))
                {
                    results.Add(entry.Location);
                }
            }
        }
        return results;
    }

    public List<SerializedFieldValueEntryDto> GetSerializedValues(string scriptGuid, string? fieldName = null)
    {
        if (string.IsNullOrWhiteSpace(scriptGuid)) return new List<SerializedFieldValueEntryDto>();
        lock (_stateLock)
        {
            if (!_fieldsByScriptGuid.TryGetValue(scriptGuid.Trim(), out var list))
            {
                return new List<SerializedFieldValueEntryDto>();
            }

            if (string.IsNullOrWhiteSpace(fieldName))
            {
                return new List<SerializedFieldValueEntryDto>(list);
            }

            return list
                .Where(f => string.Equals(f.FieldName, fieldName.Trim(), StringComparison.Ordinal))
                .ToList();
        }
    }

    private void BuildLookupTables(
        Dictionary<string, CachedAssetEntry> nextAssets,
        Dictionary<string, CachedMetaEntry> nextMetas,
        double elapsedMs)
    {
        var usagesByGuid = new Dictionary<string, List<AssetUsageLocationDto>>(StringComparer.OrdinalIgnoreCase);
        var callbacksByMethod = new Dictionary<string, List<(string, string, AssetUsageLocationDto)>>(StringComparer.Ordinal);
        var fieldsByGuid = new Dictionary<string, List<SerializedFieldValueEntryDto>>(StringComparer.OrdinalIgnoreCase);

        // Pass 1: Build cross-asset lookup table (TargetAssetGuid, ComponentFileId) -> C# ScriptGuid
        // or parent Prefab GUID so multi-hop Prefab Variant m_Modifications resolve to the script GUID.
        var componentScriptMap = new Dictionary<(string AssetGuid, string FileId), string>();
        foreach (var entry in nextAssets.Values)
        {
            var doc = entry.Document;
            if (string.IsNullOrEmpty(doc.AssetGuid)) continue;
            foreach (var comp in doc.ComponentUsages)
            {
                if (comp.UsageKind == "component" &&
                    !string.IsNullOrEmpty(comp.FileId) &&
                    !string.IsNullOrEmpty(comp.ScriptGuid))
                {
                    componentScriptMap[(doc.AssetGuid.ToLowerInvariant(), comp.FileId)] = comp.ScriptGuid;
                }
            }
        }
        foreach (var entry in nextAssets.Values)
        {
            var doc = entry.Document;
            if (string.IsNullOrEmpty(doc.AssetGuid)) continue;
            foreach (var comp in doc.ComponentUsages)
            {
                if (comp.UsageKind == "prefabOverride" &&
                    !string.IsNullOrEmpty(comp.FileId) &&
                    !string.IsNullOrEmpty(comp.ScriptGuid))
                {
                    var key = (doc.AssetGuid.ToLowerInvariant(), comp.FileId);
                    if (!componentScriptMap.ContainsKey(key))
                    {
                        componentScriptMap[key] = comp.ScriptGuid;
                    }
                }
            }
        }

        string ResolveOverrideScriptGuid(string rawGuid, string fileId)
        {
            string current = rawGuid;
            if (string.IsNullOrEmpty(current) || string.IsNullOrEmpty(fileId))
            {
                return current;
            }
            for (int hop = 0; hop < 4; hop++)
            {
                if (componentScriptMap.TryGetValue((current.ToLowerInvariant(), fileId), out var next) &&
                    !string.Equals(next, current, StringComparison.OrdinalIgnoreCase))
                {
                    current = next;
                }
                else
                {
                    break;
                }
            }
            return current;
        }

        foreach (var entry in nextAssets.Values)
        {
            var doc = entry.Document;

            foreach (var comp in doc.ComponentUsages)
            {
                string effectiveScriptGuid =
                    comp.UsageKind == "prefabOverride"
                        ? ResolveOverrideScriptGuid(comp.ScriptGuid, comp.FileId)
                        : comp.ScriptGuid;

                if (!usagesByGuid.TryGetValue(effectiveScriptGuid, out var list))
                {
                    list = new List<AssetUsageLocationDto>();
                    usagesByGuid[effectiveScriptGuid] = list;
                }

                list.Add(new AssetUsageLocationDto(
                    doc.AssetPath,
                    doc.AssetType,
                    doc.AssetGuid,
                    comp.GameObjectPath,
                    comp.FileId,
                    comp.Line,
                    comp.UsageKind,
                    null,
                    comp.SerializedValues.Count > 0 ? comp.SerializedValues : null));
            }

            foreach (var cb in doc.EventCallbacks)
            {
                if (!callbacksByMethod.TryGetValue(cb.MethodName, out var list))
                {
                    list = new List<(string, string, AssetUsageLocationDto)>();
                    callbacksByMethod[cb.MethodName] = list;
                }

                var loc = new AssetUsageLocationDto(
                    doc.AssetPath,
                    doc.AssetType,
                    doc.AssetGuid,
                    cb.GameObjectPath,
                    cb.FileId,
                    cb.Line,
                    "unityEventCallback",
                    cb.MethodName,
                    null);
                list.Add((cb.TargetScriptGuid, cb.TargetTypeName, loc));
            }

            foreach (var sv in doc.SerializedValues)
            {
                if (doc.AssetType != "scene" && doc.AssetType != "prefab" && doc.AssetType != "asset")
                {
                    continue;
                }

                string effectiveScriptGuid = ResolveOverrideScriptGuid(sv.ScriptGuid, sv.FileId);
                if (!fieldsByGuid.TryGetValue(effectiveScriptGuid, out var list))
                {
                    list = new List<SerializedFieldValueEntryDto>();
                    fieldsByGuid[effectiveScriptGuid] = list;
                }

                list.Add(new SerializedFieldValueEntryDto(
                    sv.FieldName,
                    sv.Value,
                    doc.AssetPath,
                    doc.AssetType,
                    sv.GameObjectPath,
                    sv.FileId,
                    sv.Line));
            }
        }

        lock (_stateLock)
        {
            _assetEntries = nextAssets;
            _metaEntries = nextMetas;
            _usagesByScriptGuid = usagesByGuid;
            _callbacksByMethod = callbacksByMethod;
            _fieldsByScriptGuid = fieldsByGuid;
            _lastBuildMs = elapsedMs;
        }
    }

    private void SaveToBinary(
        string cacheFilePath,
        Dictionary<string, CachedMetaEntry> metas,
        Dictionary<string, CachedAssetEntry> assets)
    {
        string? dir = Path.GetDirectoryName(cacheFilePath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        string tempPath = cacheFilePath + ".tmp";
        using (var fs = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 65536))
        using (var writer = new BinaryWriter(fs))
        {
            writer.Write(MagicHeader);
            writer.Write(FormatVersion);

            writer.Write(metas.Count);
            foreach (var m in metas.Values)
            {
                writer.Write(m.MetaRelPath);
                writer.Write(m.LastWriteUtcTicks);
                writer.Write(m.Length);
                writer.Write(m.Guid);
                writer.Write(m.AssetRelPath);
            }

            writer.Write(assets.Count);
            foreach (var a in assets.Values)
            {
                writer.Write(a.AssetPath);
                writer.Write(a.LastWriteUtcTicks);
                writer.Write(a.Length);
                writer.Write(a.Document.AssetType);
                writer.Write(a.Document.AssetGuid);

                writer.Write(a.Document.ComponentUsages.Count);
                foreach (var c in a.Document.ComponentUsages)
                {
                    writer.Write(c.ScriptGuid);
                    writer.Write(c.GameObjectPath);
                    writer.Write(c.FileId);
                    writer.Write(c.Line);
                    writer.Write(c.UsageKind);
                    writer.Write(c.SerializedValues.Count);
                    foreach (var kvp in c.SerializedValues)
                    {
                        writer.Write(kvp.Key);
                        writer.Write(kvp.Value);
                    }
                }

                writer.Write(a.Document.EventCallbacks.Count);
                foreach (var cb in a.Document.EventCallbacks)
                {
                    writer.Write(cb.TargetScriptGuid);
                    writer.Write(cb.TargetTypeName);
                    writer.Write(cb.MethodName);
                    writer.Write(cb.GameObjectPath);
                    writer.Write(cb.FileId);
                    writer.Write(cb.Line);
                }

                writer.Write(a.Document.SerializedValues.Count);
                foreach (var sv in a.Document.SerializedValues)
                {
                    writer.Write(sv.ScriptGuid);
                    writer.Write(sv.FieldName);
                    writer.Write(sv.Value);
                    writer.Write(sv.GameObjectPath);
                    writer.Write(sv.FileId);
                    writer.Write(sv.Line);
                }
            }
        }

        File.Move(tempPath, cacheFilePath, overwrite: true);
    }

    private bool TryLoadFromBinary(string cacheFilePath)
    {
        try
        {
            using var fs = new FileStream(cacheFilePath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.SequentialScan);
            using var reader = new BinaryReader(fs);

            if (reader.ReadUInt32() != MagicHeader || reader.ReadUInt32() != FormatVersion)
            {
                return false;
            }

            int metaCount = reader.ReadInt32();
            var metas = new Dictionary<string, CachedMetaEntry>(metaCount, StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < metaCount; i++)
            {
                string metaRel = reader.ReadString();
                long ticks = reader.ReadInt64();
                long len = reader.ReadInt64();
                string guid = reader.ReadString();
                string assetRel = reader.ReadString();
                metas[metaRel] = new CachedMetaEntry(metaRel, ticks, len, guid, assetRel);
            }

            int assetCount = reader.ReadInt32();
            var assets = new Dictionary<string, CachedAssetEntry>(assetCount, StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < assetCount; i++)
            {
                string assetPath = reader.ReadString();
                long ticks = reader.ReadInt64();
                long len = reader.ReadInt64();
                string assetType = reader.ReadString();
                string assetGuid = reader.ReadString();

                int compCount = reader.ReadInt32();
                var comps = new List<ComponentUsageRecord>(compCount);
                for (int c = 0; c < compCount; c++)
                {
                    string sGuid = reader.ReadString();
                    string goPath = reader.ReadString();
                    string fileId = reader.ReadString();
                    int line = reader.ReadInt32();
                    string usageKind = reader.ReadString();
                    int dictCount = reader.ReadInt32();
                    var dict = new Dictionary<string, string>(dictCount, StringComparer.Ordinal);
                    for (int d = 0; d < dictCount; d++)
                    {
                        string k = reader.ReadString();
                        string v = reader.ReadString();
                        dict[k] = v;
                    }
                    comps.Add(new ComponentUsageRecord(sGuid, goPath, fileId, line, usageKind, dict));
                }

                int cbCount = reader.ReadInt32();
                var cbs = new List<EventCallbackRecord>(cbCount);
                for (int c = 0; c < cbCount; c++)
                {
                    string tGuid = reader.ReadString();
                    string tType = reader.ReadString();
                    string mName = reader.ReadString();
                    string goPath = reader.ReadString();
                    string fileId = reader.ReadString();
                    int line = reader.ReadInt32();
                    cbs.Add(new EventCallbackRecord(tGuid, tType, mName, goPath, fileId, line));
                }

                int svCount = reader.ReadInt32();
                var svs = new List<SerializedValueRecord>(svCount);
                for (int s = 0; s < svCount; s++)
                {
                    string sGuid = reader.ReadString();
                    string fName = reader.ReadString();
                    string val = reader.ReadString();
                    string goPath = reader.ReadString();
                    string fileId = reader.ReadString();
                    int line = reader.ReadInt32();
                    svs.Add(new SerializedValueRecord(sGuid, fName, val, goPath, fileId, line));
                }

                assets[assetPath] = new CachedAssetEntry(
                    assetPath,
                    ticks,
                    len,
                    new AssetDocumentIndex(assetPath, assetType, assetGuid, comps, cbs, svs));
            }

            lock (_stateLock)
            {
                _metaEntries = metas;
                _assetEntries = assets;
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsIndexableYamlAsset(string fileName)
    {
        return fileName.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) ||
               fileName.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) ||
               fileName.EndsWith(".asset", StringComparison.OrdinalIgnoreCase) ||
               fileName.EndsWith(".controller", StringComparison.OrdinalIgnoreCase);
    }
}
