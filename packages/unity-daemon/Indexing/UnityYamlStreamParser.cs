using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace UnityBrain.Daemon.Indexing;

public sealed record ComponentUsageRecord(
    string ScriptGuid,
    string GameObjectPath,
    string FileId,
    int Line,
    string UsageKind,
    IReadOnlyDictionary<string, string> SerializedValues);

public sealed record EventCallbackRecord(
    string TargetScriptGuid,
    string TargetTypeName,
    string MethodName,
    string GameObjectPath,
    string FileId,
    int Line,
    string TargetFileId = "");

public sealed record SerializedValueRecord(
    string ScriptGuid,
    string FieldName,
    string Value,
    string GameObjectPath,
    string FileId,
    int Line);

public sealed record AssetDocumentIndex(
    string AssetPath,
    string AssetType,
    string AssetGuid,
    List<ComponentUsageRecord> ComponentUsages,
    List<EventCallbackRecord> EventCallbacks,
    List<SerializedValueRecord> SerializedValues);

public static class UnityYamlStreamParser
{
    public static string ClassifyAssetType(string assetPath)
    {
        if (assetPath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase)) return "scene";
        if (assetPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) return "prefab";
        if (assetPath.EndsWith(".controller", StringComparison.OrdinalIgnoreCase)) return "controller";
        return "asset";
    }

    public static AssetDocumentIndex ParseFile(string fullPath, string assetRelativePath, string assetGuid)
    {
        string normalizedAssetPath = assetRelativePath.Replace('\\', '/');
        string assetType = ClassifyAssetType(normalizedAssetPath);

        using var stream = new FileStream(
            fullPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite,
            bufferSize: 16384,
            options: FileOptions.SequentialScan);

        if (!LooksLikeTextYamlHeader(stream))
        {
            return new AssetDocumentIndex(
                normalizedAssetPath,
                assetType,
                assetGuid.ToLowerInvariant(),
                new List<ComponentUsageRecord>(),
                new List<EventCallbackRecord>(),
                new List<SerializedValueRecord>());
        }

        stream.Position = 0;
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return ParseReader(reader, assetRelativePath, assetGuid);
    }

    private static bool LooksLikeTextYamlHeader(Stream stream)
    {
        Span<byte> buf = stackalloc byte[64];
        int read = stream.Read(buf);
        if (read <= 0) return false;

        int offset = 0;
        if (read >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF)
        {
            offset = 3;
        }
        while (offset < read && (buf[offset] == (byte)' ' || buf[offset] == (byte)'\t' || buf[offset] == (byte)'\r' || buf[offset] == (byte)'\n'))
        {
            offset++;
        }
        if (offset >= read) return false;

        for (int i = offset; i < read; i++)
        {
            if (buf[i] == 0) return false;
        }

        ReadOnlySpan<byte> tail = buf.Slice(offset, read - offset);
        return tail.StartsWith("%YAML"u8) || tail.StartsWith("--- !u!"u8);
    }

    public static AssetDocumentIndex ParseText(string yamlContent, string assetRelativePath, string assetGuid)
    {
        using var reader = new StringReader(yamlContent);
        return ParseReader(reader, assetRelativePath, assetGuid);
    }

    private static AssetDocumentIndex ParseReader(TextReader reader, string assetRelativePath, string assetGuid)
    {
        string normalizedAssetPath = assetRelativePath.Replace('\\', '/');
        string assetType = ClassifyAssetType(normalizedAssetPath);

        var goNames = new Dictionary<string, string>(StringComparer.Ordinal);
        var transforms = new Dictionary<string, TransformInfo>(StringComparer.Ordinal);
        var goToTransform = new Dictionary<string, string>(StringComparer.Ordinal);
        var monoBehaviours = new Dictionary<string, MonoBehaviourBlock>(StringComparer.Ordinal);
        var monoBehaviourList = new List<MonoBehaviourBlock>();
        var prefabOverrides = new List<PrefabOverrideBlock>();

        int currentClassId = -1;
        string currentFileId = string.Empty;
        MonoBehaviourBlock? currentMb = null;
        PrefabOverrideBlock? currentPrefab = null;
        PendingCallback? activeCallback = null;
        PendingMod? activeMod = null;
        bool inPersistentCallsList = false;
        int persistentCallsIndent = 0;
        bool inModificationsList = false;
        int modificationsIndent = 0;
        bool checkedHeader = false;

        string? line;
        int lineNumber = 0;

        while ((line = reader.ReadLine()) != null)
        {
            lineNumber++;
            ReadOnlySpan<char> span = line.AsSpan();
            if (lineNumber == 1 && span.Length > 0 && span[0] == '\uFEFF')
            {
                span = span.Slice(1);
            }

            if (!checkedHeader)
            {
                if (span.Trim().Length == 0) continue;
                checkedHeader = true;
                if (!span.StartsWith("%YAML", StringComparison.Ordinal) &&
                    !span.StartsWith("--- !u!", StringComparison.Ordinal))
                {
                    break;
                }
            }

            if (span.StartsWith("--- !u!", StringComparison.Ordinal))
            {
                FlushPendingCallback(currentMb, ref activeCallback);
                FlushPendingList(currentMb);
                FlushPendingMod(currentPrefab, ref activeMod);
                inPersistentCallsList = false;
                inModificationsList = false;
                currentMb = null;
                currentPrefab = null;

                if (!TryParseDocumentHeader(span, out currentClassId, out currentFileId))
                {
                    currentClassId = -1;
                    currentFileId = string.Empty;
                    continue;
                }

                if (currentClassId == 114)
                {
                    currentMb = new MonoBehaviourBlock(currentFileId, lineNumber);
                    monoBehaviours[currentFileId] = currentMb;
                    monoBehaviourList.Add(currentMb);
                }
                else if (currentClassId == 1001)
                {
                    currentPrefab = new PrefabOverrideBlock(currentFileId);
                }
                continue;
            }

            if (currentClassId == -1) continue;

            int indent = CountLeadingSpaces(span);
            ReadOnlySpan<char> trimmed = span.Slice(indent);
            if (trimmed.Length == 0) continue;

            switch (currentClassId)
            {
                case 1: // GameObject
                    if (indent == 2 && TrySplitKeyValue(trimmed, out var goKey, out var goVal) &&
                        goKey.SequenceEqual("m_Name"))
                    {
                        goNames[currentFileId] = UnquoteYamlScalar(goVal);
                    }
                    break;

                case 4:   // Transform
                case 224: // RectTransform
                    if (indent == 2 && TrySplitKeyValue(trimmed, out var trKey, out var trVal))
                    {
                        if (trKey.SequenceEqual("m_GameObject") &&
                            TryExtractFieldFromFlowMap(trVal, "fileID", out var goId))
                        {
                            var info = transforms.TryGetValue(currentFileId, out var existing)
                                ? existing with { GameObjectId = goId }
                                : new TransformInfo(goId, "0");
                            transforms[currentFileId] = info;
                            if (goId != "0")
                            {
                                goToTransform[goId] = currentFileId;
                            }
                        }
                        else if (trKey.SequenceEqual("m_Father") &&
                                 TryExtractFieldFromFlowMap(trVal, "fileID", out var fatherId))
                        {
                            var info = transforms.TryGetValue(currentFileId, out var existing)
                                ? existing with { FatherTransformId = fatherId }
                                : new TransformInfo("0", fatherId);
                            transforms[currentFileId] = info;
                        }
                    }
                    break;

                case 114 when currentMb != null:
                    ParseMonoBehaviourLine(
                        trimmed,
                        indent,
                        lineNumber,
                        currentMb,
                        ref inPersistentCallsList,
                        ref persistentCallsIndent,
                        ref activeCallback);
                    break;

                case 1001 when currentPrefab != null:
                    ParsePrefabInstanceLine(
                        trimmed,
                        indent,
                        lineNumber,
                        currentPrefab,
                        prefabOverrides,
                        ref inModificationsList,
                        ref modificationsIndent,
                        ref activeMod);
                    break;
            }
        }

        FlushPendingCallback(currentMb, ref activeCallback);
        FlushPendingList(currentMb);
        FlushPendingMod(currentPrefab, ref activeMod);

        var goPathCache = BuildGameObjectPathCache(goNames, transforms, goToTransform);

        var componentUsages = new List<ComponentUsageRecord>();
        var eventCallbacks = new List<EventCallbackRecord>();
        var serializedValues = new List<SerializedValueRecord>();

        string fallbackAssetName = Path.GetFileNameWithoutExtension(normalizedAssetPath);

        foreach (var mb in monoBehaviourList)
        {
            string goPath = ResolveGameObjectPath(mb.GameObjectId, mb.AssetName, fallbackAssetName, goPathCache);

            if (!string.IsNullOrEmpty(mb.ScriptGuid))
            {
                var fieldSnapshot = new Dictionary<string, string>(mb.Fields, StringComparer.Ordinal);
                componentUsages.Add(new ComponentUsageRecord(
                    mb.ScriptGuid,
                    goPath,
                    mb.FileId,
                    mb.ScriptLine,
                    "component",
                    fieldSnapshot));

                foreach (var field in mb.FieldRecords)
                {
                    serializedValues.Add(new SerializedValueRecord(
                        mb.ScriptGuid,
                        field.Name,
                        field.Value,
                        goPath,
                        mb.FileId,
                        field.Line));

                    if (TryExtractFieldFromFlowMap(field.Value.AsSpan(), "guid", out var refGuid) &&
                        !string.IsNullOrEmpty(refGuid) &&
                        !string.Equals(refGuid, "00000000000000000000000000000000", StringComparison.Ordinal))
                    {
                        componentUsages.Add(new ComponentUsageRecord(
                            refGuid.ToLowerInvariant(),
                            goPath,
                            mb.FileId,
                            field.Line,
                            "serializedReference",
                            new Dictionary<string, string> { [field.Name] = field.Value }));
                    }
                }
            }

            foreach (var cb in mb.PendingCallbacks)
            {
                if (string.IsNullOrEmpty(cb.MethodName)) continue;

                string targetGuid = cb.TargetGuid;
                if (!string.IsNullOrEmpty(cb.TargetFileId) &&
                    cb.TargetFileId != "0" &&
                    monoBehaviours.TryGetValue(cb.TargetFileId, out var targetMb) &&
                    !string.IsNullOrEmpty(targetMb.ScriptGuid))
                {
                    targetGuid = targetMb.ScriptGuid;
                }

                string cleanTypeName = CleanAssemblyTypeName(cb.TargetAssemblyTypeName);
                eventCallbacks.Add(new EventCallbackRecord(
                    targetGuid.ToLowerInvariant(),
                    cleanTypeName,
                    cb.MethodName,
                    goPath,
                    mb.FileId,
                    cb.MethodLine,
                    cb.TargetFileId));
            }
        }

        foreach (var prefab in prefabOverrides)
        {
            string parentPath = ResolveTransformPath(prefab.ParentTransformId, transforms, goPathCache);
            foreach (var mod in prefab.Modifications)
            {
                if (string.IsNullOrEmpty(mod.TargetGuid)) continue;

                string modPath = string.IsNullOrEmpty(parentPath)
                    ? $"{fallbackAssetName} (PrefabOverride)"
                    : $"{parentPath} (PrefabOverride)";

                string modTargetFileId = !string.IsNullOrEmpty(mod.TargetFileId) ? mod.TargetFileId : prefab.FileId;
                var dict = new Dictionary<string, string>(StringComparer.Ordinal);
                if (!string.IsNullOrEmpty(mod.PropertyPath))
                {
                    string effectiveValue = !string.IsNullOrEmpty(mod.Value) ? mod.Value : mod.ObjectReference;
                    dict[mod.PropertyPath] = effectiveValue;
                    serializedValues.Add(new SerializedValueRecord(
                        mod.TargetGuid.ToLowerInvariant(),
                        mod.PropertyPath,
                        effectiveValue,
                        modPath,
                        modTargetFileId,
                        mod.Line));
                }

                componentUsages.Add(new ComponentUsageRecord(
                    mod.TargetGuid.ToLowerInvariant(),
                    modPath,
                    modTargetFileId,
                    mod.Line,
                    "prefabOverride",
                    dict));
            }
        }

        return new AssetDocumentIndex(
            normalizedAssetPath,
            assetType,
            assetGuid.ToLowerInvariant(),
            componentUsages,
            eventCallbacks,
            serializedValues);
    }

    private static void ParseMonoBehaviourLine(
        ReadOnlySpan<char> trimmed,
        int indent,
        int lineNumber,
        MonoBehaviourBlock mb,
        ref bool inPersistentCallsList,
        ref int persistentCallsIndent,
        ref PendingCallback? activeCallback)
    {
        if (inPersistentCallsList &&
            (indent < persistentCallsIndent ||
             (indent == persistentCallsIndent &&
              !trimmed.StartsWith("- ", StringComparison.Ordinal) &&
              !trimmed.SequenceEqual("-"))))
        {
            FlushPendingCallback(mb, ref activeCallback);
            inPersistentCallsList = false;
        }

        if (inPersistentCallsList && indent == persistentCallsIndent && trimmed.StartsWith("- ", StringComparison.Ordinal))
        {
            FlushPendingCallback(mb, ref activeCallback);
            activeCallback = new PendingCallback { MethodLine = lineNumber };
            ReadOnlySpan<char> itemRest = trimmed.Slice(2).TrimStart();
            if (TrySplitKeyValue(itemRest, out var k0, out var v0))
            {
                ApplyCallbackField(activeCallback, k0, v0, lineNumber);
            }
            return;
        }

        if (inPersistentCallsList && activeCallback != null && indent > persistentCallsIndent)
        {
            if (TrySplitKeyValue(trimmed, out var ck, out var cv))
            {
                ApplyCallbackField(activeCallback, ck, cv, lineNumber);
            }
            return;
        }

        if (TrySplitKeyValue(trimmed, out var earlyKey, out var earlyVal))
        {
            if (earlyKey.SequenceEqual("m_PersistentCalls") && earlyVal.Length == 0)
            {
                if (mb.PendingListName != null)
                {
                    mb.PendingListName = null;
                    mb.PendingListCount = 0;
                    mb.PendingListItemIndent = -1;
                    mb.HasPendingNestedFields = false;
                }
                return;
            }
            if (earlyKey.SequenceEqual("m_Calls") && earlyVal.Length == 0)
            {
                if (mb.PendingListName != null)
                {
                    mb.PendingListName = null;
                    mb.PendingListCount = 0;
                    mb.PendingListItemIndent = -1;
                    mb.HasPendingNestedFields = false;
                }
                inPersistentCallsList = true;
                persistentCallsIndent = indent;
                return;
            }
        }

        if (mb.PendingListName != null)
        {
            if (!mb.HasPendingNestedFields &&
                indent >= mb.PendingListIndent &&
                (trimmed.StartsWith("- ", StringComparison.Ordinal) || trimmed.SequenceEqual("-")))
            {
                if (mb.PendingListItemIndent < 0 || indent == mb.PendingListItemIndent)
                {
                    mb.PendingListItemIndent = indent;
                    mb.PendingListCount++;
                }
                return;
            }
            if (indent <= mb.PendingListIndent)
            {
                FlushPendingList(mb);
            }
            else
            {
                if (mb.PendingListCount == 0 &&
                    !trimmed.StartsWith("- ", StringComparison.Ordinal) &&
                    !trimmed.SequenceEqual("-") &&
                    TrySplitKeyValue(trimmed, out var subKey, out var subVal))
                {
                    mb.HasPendingNestedFields = true;
                    if (subVal.Length > 0 &&
                        !subKey.StartsWith("m_", StringComparison.Ordinal) &&
                        !subKey.SequenceEqual("fileID"))
                    {
                        string cleanSubKey = NormalizeBackingFieldKey(subKey.ToString());
                        string nestedKey = $"{mb.PendingListName}.{cleanSubKey}";
                        string cleanSubVal = UnquoteYamlScalar(subVal);
                        if (cleanSubVal.Length > 0)
                        {
                            mb.Fields[nestedKey] = cleanSubVal;
                            mb.FieldRecords.Add(new FieldEntry(nestedKey, cleanSubVal, lineNumber));
                        }
                    }
                }
                return;
            }
        }

        if (!TrySplitKeyValue(trimmed, out var key, out var val))
        {
            return;
        }

        if (indent != 2)
        {
            return;
        }

        if (key.SequenceEqual("m_GameObject"))
        {
            if (TryExtractFieldFromFlowMap(val, "fileID", out var goId))
            {
                mb.GameObjectId = goId;
            }
            return;
        }

        if (key.SequenceEqual("m_Script"))
        {
            mb.ScriptLine = lineNumber;
            if (TryExtractFieldFromFlowMap(val, "guid", out var guid))
            {
                mb.ScriptGuid = guid.ToLowerInvariant();
            }
            return;
        }

        if (key.SequenceEqual("m_Name"))
        {
            mb.AssetName = UnquoteYamlScalar(val);
            return;
        }

        if (key.StartsWith("m_", StringComparison.Ordinal))
        {
            return;
        }

        string keyStr = NormalizeBackingFieldKey(key.ToString());
        if (val.SequenceEqual("[]"))
        {
            mb.Fields[keyStr] = "[0 items]";
            mb.FieldRecords.Add(new FieldEntry(keyStr, "[0 items]", lineNumber));
            return;
        }

        if (val.Length == 0)
        {
            mb.PendingListName = keyStr;
            mb.PendingListLine = lineNumber;
            mb.PendingListIndent = indent;
            mb.PendingListItemIndent = -1;
            mb.PendingListCount = 0;
            mb.HasPendingNestedFields = false;
            return;
        }

        string cleanVal = UnquoteYamlScalar(val);
        if (cleanVal.Length == 0)
        {
            return;
        }

        mb.Fields[keyStr] = cleanVal;
        mb.FieldRecords.Add(new FieldEntry(keyStr, cleanVal, lineNumber));
    }

    private static void ApplyCallbackField(PendingCallback cb, ReadOnlySpan<char> key, ReadOnlySpan<char> val, int lineNumber)
    {
        if (key.SequenceEqual("m_Target"))
        {
            if (TryExtractFieldFromFlowMap(val, "fileID", out var fileId))
            {
                cb.TargetFileId = fileId;
            }
            if (TryExtractFieldFromFlowMap(val, "guid", out var guid))
            {
                cb.TargetGuid = guid;
            }
        }
        else if (key.SequenceEqual("m_TargetAssemblyTypeName"))
        {
            cb.TargetAssemblyTypeName = UnquoteYamlScalar(val);
        }
        else if (key.SequenceEqual("m_MethodName"))
        {
            cb.MethodName = UnquoteYamlScalar(val);
            cb.MethodLine = lineNumber;
        }
    }

    private static void ParsePrefabInstanceLine(
        ReadOnlySpan<char> trimmed,
        int indent,
        int lineNumber,
        PrefabOverrideBlock prefab,
        List<PrefabOverrideBlock> allPrefabs,
        ref bool inModificationsList,
        ref int modificationsIndent,
        ref PendingMod? activeMod)
    {
        if (inModificationsList &&
            (indent < modificationsIndent ||
             (indent == modificationsIndent &&
              !trimmed.StartsWith("- ", StringComparison.Ordinal) &&
              !trimmed.SequenceEqual("-"))))
        {
            FlushPendingMod(prefab, ref activeMod);
            inModificationsList = false;
        }

        if (inModificationsList && indent == modificationsIndent && trimmed.StartsWith("- ", StringComparison.Ordinal))
        {
            FlushPendingMod(prefab, ref activeMod);
            activeMod = new PendingMod { Line = lineNumber };
            ReadOnlySpan<char> itemRest = trimmed.Slice(2).TrimStart();
            if (TrySplitKeyValue(itemRest, out var mk0, out var mv0))
            {
                ApplyModField(activeMod, mk0, mv0, lineNumber);
            }
            return;
        }

        if (inModificationsList && activeMod != null && indent > modificationsIndent)
        {
            if (TrySplitKeyValue(trimmed, out var mk, out var mv))
            {
                ApplyModField(activeMod, mk, mv, lineNumber);
            }
            return;
        }

        if (TrySplitKeyValue(trimmed, out var key, out var val))
        {
            if (key.SequenceEqual("m_TransformParent") &&
                TryExtractFieldFromFlowMap(val, "fileID", out var parentTr))
            {
                prefab.ParentTransformId = parentTr;
            }
            else if (key.SequenceEqual("m_Modifications") && val.Length == 0)
            {
                inModificationsList = true;
                modificationsIndent = indent;
                if (!allPrefabs.Contains(prefab))
                {
                    allPrefabs.Add(prefab);
                }
            }
        }
    }

    private static void ApplyModField(PendingMod mod, ReadOnlySpan<char> key, ReadOnlySpan<char> val, int lineNumber)
    {
        if (key.SequenceEqual("target"))
        {
            if (TryExtractFieldFromFlowMap(val, "fileID", out var fid)) mod.TargetFileId = fid;
            if (TryExtractFieldFromFlowMap(val, "guid", out var guid)) mod.TargetGuid = guid;
        }
        else if (key.SequenceEqual("propertyPath"))
        {
            mod.PropertyPath = UnquoteYamlScalar(val);
            mod.Line = lineNumber;
        }
        else if (key.SequenceEqual("value"))
        {
            mod.Value = UnquoteYamlScalar(val);
        }
        else if (key.SequenceEqual("objectReference"))
        {
            var raw = val.Trim().ToString();
            if (!string.IsNullOrEmpty(raw) && !raw.Contains("fileID: 0}", StringComparison.Ordinal))
            {
                mod.ObjectReference = raw;
            }
        }
    }

    private static void FlushPendingCallback(MonoBehaviourBlock? mb, ref PendingCallback? cb)
    {
        if (mb != null && cb != null && !string.IsNullOrEmpty(cb.MethodName))
        {
            mb.PendingCallbacks.Add(cb);
        }
        cb = null;
    }

    private static void FlushPendingList(MonoBehaviourBlock? mb)
    {
        if (mb != null && mb.PendingListName != null)
        {
            if (mb.PendingListCount > 0 && !mb.HasPendingNestedFields)
            {
                string summary = $"[{mb.PendingListCount} items]";
                mb.Fields[mb.PendingListName] = summary;
                mb.FieldRecords.Add(new FieldEntry(mb.PendingListName, summary, mb.PendingListLine));
            }
            mb.PendingListName = null;
            mb.PendingListCount = 0;
            mb.PendingListItemIndent = -1;
            mb.HasPendingNestedFields = false;
        }
    }

    private static void FlushPendingMod(PrefabOverrideBlock? prefab, ref PendingMod? mod)
    {
        if (prefab != null && mod != null && !string.IsNullOrEmpty(mod.TargetGuid))
        {
            prefab.Modifications.Add(mod);
        }
        mod = null;
    }

    private static Dictionary<string, string> BuildGameObjectPathCache(
        Dictionary<string, string> goNames,
        Dictionary<string, TransformInfo> transforms,
        Dictionary<string, string> goToTransform)
    {
        var cache = new Dictionary<string, string>(StringComparer.Ordinal);
        var stack = new Stack<string>();
        var visited = new HashSet<string>(StringComparer.Ordinal);

        foreach (var goId in goNames.Keys)
        {
            if (cache.ContainsKey(goId)) continue;

            stack.Clear();
            visited.Clear();
            string curGo = goId;

            while (!string.IsNullOrEmpty(curGo) && curGo != "0" && visited.Add(curGo))
            {
                if (cache.TryGetValue(curGo, out var cachedPath))
                {
                    stack.Push(cachedPath);
                    break;
                }

                string name = goNames.TryGetValue(curGo, out var n) && !string.IsNullOrEmpty(n) ? n : "GameObject";
                stack.Push(name);

                if (!goToTransform.TryGetValue(curGo, out var trId) ||
                    !transforms.TryGetValue(trId, out var trInfo) ||
                    string.IsNullOrEmpty(trInfo.FatherTransformId) ||
                    trInfo.FatherTransformId == "0" ||
                    !transforms.TryGetValue(trInfo.FatherTransformId, out var fatherTr))
                {
                    break;
                }

                curGo = fatherTr.GameObjectId;
            }

            if (stack.Count > 0)
            {
                cache[goId] = string.Join('/', stack);
            }
        }

        return cache;
    }

    private static string ResolveGameObjectPath(
        string goId,
        string assetName,
        string fallbackAssetName,
        Dictionary<string, string> goPathCache)
    {
        if (!string.IsNullOrEmpty(goId) && goId != "0" && goPathCache.TryGetValue(goId, out var path))
        {
            return path;
        }
        return !string.IsNullOrEmpty(assetName) ? assetName : fallbackAssetName;
    }

    private static string ResolveTransformPath(
        string parentTransformId,
        Dictionary<string, TransformInfo> transforms,
        Dictionary<string, string> goPathCache)
    {
        if (string.IsNullOrEmpty(parentTransformId) || parentTransformId == "0")
        {
            return string.Empty;
        }
        if (transforms.TryGetValue(parentTransformId, out var tr) &&
            !string.IsNullOrEmpty(tr.GameObjectId) &&
            goPathCache.TryGetValue(tr.GameObjectId, out var path))
        {
            return path;
        }
        return string.Empty;
    }

    private static bool TryParseDocumentHeader(ReadOnlySpan<char> line, out int classId, out string fileId)
    {
        classId = -1;
        fileId = string.Empty;
        ReadOnlySpan<char> rest = line.Slice("--- !u!".Length);
        int ampIdx = rest.IndexOf('&');
        if (ampIdx <= 0) return false;

        ReadOnlySpan<char> classSpan = rest.Slice(0, ampIdx).Trim();
        if (!int.TryParse(classSpan, out classId)) return false;

        ReadOnlySpan<char> idSpan = rest.Slice(ampIdx + 1).Trim();
        int spaceIdx = idSpan.IndexOf(' ');
        if (spaceIdx > 0)
        {
            idSpan = idSpan.Slice(0, spaceIdx);
        }

        fileId = idSpan.ToString();
        return fileId.Length > 0;
    }

    private static int CountLeadingSpaces(ReadOnlySpan<char> span)
    {
        int i = 0;
        while (i < span.Length && span[i] == ' ')
        {
            i++;
        }
        return i;
    }

    private static bool TrySplitKeyValue(ReadOnlySpan<char> trimmed, out ReadOnlySpan<char> key, out ReadOnlySpan<char> value)
    {
        int colonIdx = trimmed.IndexOf(':');
        if (colonIdx <= 0)
        {
            key = default;
            value = default;
            return false;
        }

        key = trimmed.Slice(0, colonIdx).TrimEnd();
        value = colonIdx + 1 < trimmed.Length ? trimmed.Slice(colonIdx + 1).Trim() : ReadOnlySpan<char>.Empty;
        return true;
    }

    private static bool TryExtractFieldFromFlowMap(ReadOnlySpan<char> val, string fieldName, out string result)
    {
        result = string.Empty;
        if (val.Length < 4 || val[0] != '{') return false;

        int searchFrom = 0;
        while (searchFrom < val.Length)
        {
            int idx = val.Slice(searchFrom).IndexOf(fieldName, StringComparison.Ordinal);
            if (idx < 0) return false;

            int absIdx = searchFrom + idx;
            bool validStart = absIdx == 0 || !char.IsLetterOrDigit(val[absIdx - 1]);
            int afterKey = absIdx + fieldName.Length;
            if (validStart && afterKey < val.Length && val[afterKey] == ':')
            {
                ReadOnlySpan<char> afterColon = val.Slice(afterKey + 1).TrimStart();
                int end = afterColon.IndexOfAny(',', '}');
                ReadOnlySpan<char> slice = end >= 0 ? afterColon.Slice(0, end).Trim() : afterColon.Trim();
                result = slice.ToString();
                return result.Length > 0;
            }

            searchFrom = absIdx + 1;
        }

        return false;
    }

    private static string UnquoteYamlScalar(ReadOnlySpan<char> val)
    {
        val = val.Trim();
        if (val.Length >= 2 &&
            ((val[0] == '"' && val[val.Length - 1] == '"') ||
             (val[0] == '\'' && val[val.Length - 1] == '\'')))
        {
            val = val.Slice(1, val.Length - 2);
        }
        return val.ToString();
    }

    private static string NormalizeBackingFieldKey(string keyStr)
    {
        const string suffix = ">k__BackingField";
        if (keyStr.Length > suffix.Length + 1 &&
            keyStr[0] == '<' &&
            keyStr.EndsWith(suffix, StringComparison.Ordinal))
        {
            string inner = keyStr.Substring(1, keyStr.Length - 1 - suffix.Length);
            if (IsValidCSharpIdentifier(inner))
            {
                return inner;
            }
        }
        return keyStr;
    }

    private static bool IsValidCSharpIdentifier(string s)
    {
        if (s.Length == 0) return false;
        char first = s[0];
        if (!((first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z') || first == '_'))
        {
            return false;
        }
        for (int i = 1; i < s.Length; i++)
        {
            char c = s[i];
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'))
            {
                return false;
            }
        }
        return true;
    }

    private static string CleanAssemblyTypeName(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
        int comma = raw.IndexOf(',');
        string typePart = (comma >= 0 ? raw.Substring(0, comma) : raw).Trim();
        int plus = typePart.LastIndexOf('+');
        if (plus >= 0) return typePart.Substring(plus + 1);
        int dot = typePart.LastIndexOf('.');
        return dot >= 0 ? typePart.Substring(dot + 1) : typePart;
    }

    private readonly record struct TransformInfo(string GameObjectId, string FatherTransformId);
    private readonly record struct FieldEntry(string Name, string Value, int Line);

    private sealed class MonoBehaviourBlock
    {
        public string FileId { get; }
        public int ScriptLine { get; set; }
        public string GameObjectId { get; set; } = "0";
        public string AssetName { get; set; } = string.Empty;
        public string ScriptGuid { get; set; } = string.Empty;
        public Dictionary<string, string> Fields { get; } = new(StringComparer.Ordinal);
        public List<FieldEntry> FieldRecords { get; } = new();
        public List<PendingCallback> PendingCallbacks { get; } = new();
        public string? PendingListName { get; set; }
        public int PendingListLine { get; set; }
        public int PendingListIndent { get; set; }
        public int PendingListItemIndent { get; set; } = -1;
        public int PendingListCount { get; set; }
        public bool HasPendingNestedFields { get; set; }

        public MonoBehaviourBlock(string fileId, int startLine)
        {
            FileId = fileId;
            ScriptLine = startLine;
        }
    }

    private sealed class PendingCallback
    {
        public string TargetFileId { get; set; } = string.Empty;
        public string TargetGuid { get; set; } = string.Empty;
        public string TargetAssemblyTypeName { get; set; } = string.Empty;
        public string MethodName { get; set; } = string.Empty;
        public int MethodLine { get; set; }
    }

    private sealed class PrefabOverrideBlock
    {
        public string FileId { get; }
        public string ParentTransformId { get; set; } = string.Empty;
        public List<PendingMod> Modifications { get; } = new();

        public PrefabOverrideBlock(string fileId)
        {
            FileId = fileId;
        }
    }

    private sealed class PendingMod
    {
        public string TargetFileId { get; set; } = string.Empty;
        public string TargetGuid { get; set; } = string.Empty;
        public string PropertyPath { get; set; } = string.Empty;
        public string Value { get; set; } = string.Empty;
        public string ObjectReference { get; set; } = string.Empty;
        public int Line { get; set; }
    }
}
