using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace UnityBrain.Daemon.Indexing;

public readonly record struct FileStamp(long LastWriteUtcTicks, long Length);

public sealed class MetaGuidMap
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, string> _guidToPath = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _pathToGuid = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, FileStamp> _metaStamps = new(StringComparer.OrdinalIgnoreCase);

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _guidToPath.Count;
            }
        }
    }

    public static string? TryReadGuidFast(string metaFullPath)
    {
        if (!File.Exists(metaFullPath))
        {
            return null;
        }

        using var stream = new FileStream(metaFullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096);
        using var reader = new StreamReader(stream);

        string? line;
        int lineLimit = 16;
        while (lineLimit-- > 0 && (line = reader.ReadLine()) != null)
        {
            ReadOnlySpan<char> span = line.AsSpan().TrimStart();
            if (!span.StartsWith("guid:", StringComparison.Ordinal))
            {
                continue;
            }

            ReadOnlySpan<char> value = span.Slice("guid:".Length).Trim();
            if (value.Length == 32 && IsHexString(value))
            {
                return value.ToString().ToLowerInvariant();
            }
        }

        return null;
    }

    private static bool IsHexString(ReadOnlySpan<char> span)
    {
        for (int i = 0; i < span.Length; i++)
        {
            char c = span[i];
            bool isHex = (c >= '0' && c <= '9') ||
                         (c >= 'a' && c <= 'f') ||
                         (c >= 'A' && c <= 'F');
            if (!isHex) return false;
        }
        return true;
    }

    public void Clear()
    {
        lock (_gate)
        {
            _guidToPath.Clear();
            _pathToGuid.Clear();
            _metaStamps.Clear();
        }
    }

    public void Rebuild(string projectRoot)
    {
        var guidToPath = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var pathToGuid = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var metaStamps = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);

        string assetsDir = Path.Combine(projectRoot, "Assets");
        if (Directory.Exists(assetsDir))
        {
            var opts = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true,
                AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
            };

            foreach (var metaPath in Directory.EnumerateFiles(assetsDir, "*.meta", opts))
            {
                var info = new FileInfo(metaPath);
                var guid = TryReadGuidFast(metaPath);
                if (guid == null) continue;

                string relMeta = Path.GetRelativePath(projectRoot, metaPath).Replace('\\', '/');
                string assetRel = relMeta.EndsWith(".meta", StringComparison.OrdinalIgnoreCase)
                    ? relMeta.Substring(0, relMeta.Length - ".meta".Length)
                    : relMeta;

                guidToPath[guid] = assetRel;
                pathToGuid[assetRel] = guid;
                metaStamps[relMeta] = new FileStamp(info.LastWriteTimeUtc.Ticks, info.Length);
            }
        }

        lock (_gate)
        {
            _guidToPath.Clear();
            _pathToGuid.Clear();
            _metaStamps.Clear();

            foreach (var kvp in guidToPath) _guidToPath[kvp.Key] = kvp.Value;
            foreach (var kvp in pathToGuid) _pathToGuid[kvp.Key] = kvp.Value;
            foreach (var kvp in metaStamps) _metaStamps[kvp.Key] = kvp.Value;
        }
    }

    public void SetMapping(string guid, string assetRelativePath, string? metaRelativePath = null, FileStamp stamp = default)
    {
        string normGuid = guid.Trim().ToLowerInvariant();
        string normAsset = assetRelativePath.Replace('\\', '/');
        string normMeta = (metaRelativePath ?? (normAsset + ".meta")).Replace('\\', '/');

        lock (_gate)
        {
            if (_guidToPath.TryGetValue(normGuid, out var oldAsset) &&
                !string.Equals(oldAsset, normAsset, StringComparison.OrdinalIgnoreCase))
            {
                _pathToGuid.Remove(oldAsset);
            }

            if (_pathToGuid.TryGetValue(normAsset, out var oldGuid) &&
                !string.Equals(oldGuid, normGuid, StringComparison.OrdinalIgnoreCase))
            {
                _guidToPath.Remove(oldGuid);
            }

            _guidToPath[normGuid] = normAsset;
            _pathToGuid[normAsset] = normGuid;
            if (stamp != default)
            {
                _metaStamps[normMeta] = stamp;
            }
        }
    }

    public bool UpdateMetaFile(string projectRoot, string metaFullPath)
    {
        string relMeta = Path.GetRelativePath(projectRoot, metaFullPath).Replace('\\', '/');
        if (!File.Exists(metaFullPath))
        {
            RemoveMetaFile(relMeta);
            return true;
        }

        var info = new FileInfo(metaFullPath);
        var stamp = new FileStamp(info.LastWriteTimeUtc.Ticks, info.Length);

        lock (_gate)
        {
            if (_metaStamps.TryGetValue(relMeta, out var prev) && prev == stamp)
            {
                return false;
            }
        }

        var guid = TryReadGuidFast(metaFullPath);
        if (guid == null)
        {
            RemoveMetaFile(relMeta);
            return true;
        }

        string assetRel = relMeta.EndsWith(".meta", StringComparison.OrdinalIgnoreCase)
            ? relMeta.Substring(0, relMeta.Length - ".meta".Length)
            : relMeta;

        SetMapping(guid, assetRel, relMeta, stamp);
        return true;
    }

    public void RemoveMetaFile(string metaRelativePath)
    {
        string normMeta = metaRelativePath.Replace('\\', '/');
        string assetRel = normMeta.EndsWith(".meta", StringComparison.OrdinalIgnoreCase)
            ? normMeta.Substring(0, normMeta.Length - ".meta".Length)
            : normMeta;

        lock (_gate)
        {
            _metaStamps.Remove(normMeta);
            if (_pathToGuid.Remove(assetRel, out var guid))
            {
                _guidToPath.Remove(guid);
            }
        }
    }

    public bool TryGetAssetPath(string guid, out string assetPath)
    {
        lock (_gate)
        {
            return _guidToPath.TryGetValue(guid, out assetPath!);
        }
    }

    public bool TryGetGuid(string assetRelativePath, out string guid)
    {
        string normalized = assetRelativePath.Replace('\\', '/');
        lock (_gate)
        {
            return _pathToGuid.TryGetValue(normalized, out guid!);
        }
    }

    public IReadOnlyDictionary<string, string> ExportGuidToPathSnapshot()
    {
        lock (_gate)
        {
            return new Dictionary<string, string>(_guidToPath, StringComparer.OrdinalIgnoreCase);
        }
    }
}
