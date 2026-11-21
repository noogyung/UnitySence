using System;
using System.Collections.Generic;
using System.IO;

namespace UnityBrain.Daemon.Indexing;

public readonly record struct FileStamp(long LastWriteUtcTicks, long Length);

public sealed class MetaGuidMap
{
    private readonly object _gate = new();
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
        try
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
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
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

    public static IEnumerable<FileInfo> EnumerateFilesSafe(string rootDir)
    {
        if (!Directory.Exists(rootDir))
        {
            yield break;
        }

        var pathComparer = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;
        var visitedDirs = new HashSet<string>(pathComparer);
        var stack = new Stack<DirectoryInfo>();
        stack.Push(new DirectoryInfo(rootDir));

        while (stack.Count > 0)
        {
            var current = stack.Pop();
            string canonical;
            try
            {
                var target = current.ResolveLinkTarget(returnFinalTarget: true);
                canonical = Path.GetFullPath(target?.FullName ?? current.FullName);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            if (!visitedDirs.Add(canonical))
            {
                continue;
            }

            FileInfo[] files;
            DirectoryInfo[] subDirs;
            try
            {
                files = current.GetFiles();
                subDirs = current.GetDirectories();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var file in files)
            {
                if ((file.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0)
                {
                    continue;
                }
                yield return file;
            }

            foreach (var sub in subDirs)
            {
                if ((sub.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0 ||
                    sub.Name.StartsWith('.'))
                {
                    continue;
                }
                stack.Push(sub);
            }
        }
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

        var scanRoots = new[]
        {
            Path.Combine(projectRoot, "Assets"),
            Path.Combine(projectRoot, "Packages"),
        };

        foreach (var scanDir in scanRoots)
        {
            foreach (var info in EnumerateFilesSafe(scanDir))
            {
                if (!info.Name.EndsWith(".meta", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                long ticks;
                long length;
                try
                {
                    ticks = info.LastWriteTimeUtc.Ticks;
                    length = info.Length;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    continue;
                }

                var guid = TryReadGuidFast(info.FullName);
                if (guid == null) continue;

                string relMeta = Path.GetRelativePath(projectRoot, info.FullName).Replace('\\', '/');
                string assetRel = relMeta.EndsWith(".meta", StringComparison.OrdinalIgnoreCase)
                    ? relMeta.Substring(0, relMeta.Length - ".meta".Length)
                    : relMeta;

                guidToPath[guid] = assetRel;
                pathToGuid[assetRel] = guid;
                metaStamps[relMeta] = new FileStamp(ticks, length);
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

        FileStamp stamp;
        try
        {
            var info = new FileInfo(metaFullPath);
            stamp = new FileStamp(info.LastWriteTimeUtc.Ticks, info.Length);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }

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
