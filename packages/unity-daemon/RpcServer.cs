using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using UnityBrain.Daemon.Cache;

namespace UnityBrain.Daemon;

public sealed class RpcServer
{
    private const int MaxHeaderBytes = 8192;
    private const int MaxContentLength = 16 * 1024 * 1024;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly BinaryIndexCache _cache;
    private readonly string _projectRoot;
    private readonly string _cacheFilePath;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public RpcServer(BinaryIndexCache cache, string projectRoot, string cacheFilePath)
    {
        _cache = cache;
        _projectRoot = projectRoot;
        _cacheFilePath = cacheFilePath;
    }

    public async Task RunAsync(Stream input, Stream output, CancellationToken cancellationToken = default)
    {
        var readerState = new StreamFrameBuffer();
        while (!cancellationToken.IsCancellationRequested)
        {
            byte[]? payload;
            try
            {
                payload = await ReadFrameAsync(input, readerState, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (InvalidDataException ex)
            {
                try
                {
                    await WriteErrorResponseObjectAsync(output, null, -32700, ex.Message, cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    break;
                }
                continue;
            }

            if (payload == null)
            {
                break;
            }

            if (payload.Length == 0)
            {
                continue;
            }

            bool shouldStop = false;
            bool hasId = false;
            object? parsedIdObj = null;

            try
            {
                using var doc = JsonDocument.Parse(payload);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    await WriteErrorResponseObjectAsync(output, null, -32600, "Invalid Request", cancellationToken).ConfigureAwait(false);
                    continue;
                }

                string? method = root.TryGetProperty("method", out var mEl) && mEl.ValueKind == JsonValueKind.String
                    ? mEl.GetString()
                    : null;
                hasId = root.TryGetProperty("id", out var idEl) && idEl.ValueKind != JsonValueKind.Undefined;
                if (hasId)
                {
                    parsedIdObj = ExtractJsonIdValue(idEl);
                }
                JsonElement paramsEl = root.TryGetProperty("params", out var pEl) ? pEl : default;

                if (method == "exit")
                {
                    break;
                }

                object? result = null;
                string? errorMsg = null;
                int errorCode = 0;

                switch (method)
                {
                    case "index/status":
                        result = _cache.GetStatus();
                        break;

                    case "index/rebuild":
                    {
                        bool force = paramsEl.ValueKind == JsonValueKind.Object &&
                                     ((paramsEl.TryGetProperty("force", out var fEl) && fEl.ValueKind == JsonValueKind.True) ||
                                      (paramsEl.TryGetProperty("forceFull", out var ffEl) && ffEl.ValueKind == JsonValueKind.True));
                        result = _cache.BuildOrUpdateIndex(_projectRoot, _cacheFilePath, force);
                        break;
                    }

                    case "usage/findByScriptGuid":
                    {
                        string guid = GetStringParam(paramsEl, "scriptGuid")
                                   ?? GetStringParam(paramsEl, "guid")
                                   ?? string.Empty;
                        var locations = _cache.FindByScriptGuid(guid);
                        result = new { locations };
                        break;
                    }

                    case "usage/findByMethod":
                    {
                        string? guid = GetStringParam(paramsEl, "scriptGuid")
                                    ?? GetStringParam(paramsEl, "guid");
                        string? className = GetStringParam(paramsEl, "className");
                        string methodName = GetStringParam(paramsEl, "methodName") ?? string.Empty;
                        var locations = _cache.FindByMethod(guid, className, methodName);
                        result = new { locations };
                        break;
                    }

                    case "inspector/getSerializedValues":
                    {
                        string guid = GetStringParam(paramsEl, "scriptGuid")
                                   ?? GetStringParam(paramsEl, "guid")
                                   ?? string.Empty;
                        string? fieldName = GetStringParam(paramsEl, "fieldName");
                        var fields = _cache.GetSerializedValues(guid, fieldName);
                        result = new { fields };
                        break;
                    }

                    case "shutdown":
                        shouldStop = true;
                        result = new { ok = true };
                        break;

                    default:
                        errorCode = -32601;
                        errorMsg = $"Method not found: {method}";
                        break;
                }

                if (hasId)
                {
                    if (errorMsg != null)
                    {
                        await WriteErrorResponseObjectAsync(output, parsedIdObj, errorCode, errorMsg, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        await WriteSuccessResponseAsync(output, parsedIdObj, result, cancellationToken).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception ex)
            {
                if (!hasId)
                {
                    continue;
                }
                try
                {
                    await WriteErrorResponseObjectAsync(output, parsedIdObj, -32603, ex.Message, cancellationToken).ConfigureAwait(false);
                }
                catch
                {
                    break;
                }
            }

            if (shouldStop)
            {
                break;
            }
        }
    }

    private static object? ExtractJsonIdValue(JsonElement idEl)
    {
        return idEl.ValueKind switch
        {
            JsonValueKind.Number => idEl.TryGetInt64(out var l) ? l : idEl.GetDouble(),
            JsonValueKind.String => idEl.GetString(),
            _ => null,
        };
    }

    public static byte[] EncodeFrame(object payloadObject)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(payloadObject, JsonOptions);
        byte[] header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        byte[] combined = new byte[header.Length + body.Length];
        Buffer.BlockCopy(header, 0, combined, 0, header.Length);
        Buffer.BlockCopy(body, 0, combined, header.Length, body.Length);
        return combined;
    }

    private sealed class StreamFrameBuffer
    {
        public byte[] Buffer = new byte[8192];
        public int Offset;
        public int Count;

        public void Consume(int bytes)
        {
            Offset += bytes;
            Count -= bytes;
            if (Count <= 0)
            {
                Offset = 0;
                Count = 0;
            }
            else if (Offset > Buffer.Length / 2)
            {
                System.Buffer.BlockCopy(Buffer, Offset, Buffer, 0, Count);
                Offset = 0;
            }
        }
    }

    public static async Task<byte[]?> ReadFrameAsync(Stream input, CancellationToken cancellationToken)
    {
        var headerBytes = new List<byte>(128);
        var single = new byte[1];
        int terminatorLength = 0;

        while (true)
        {
            int n = await input.ReadAsync(single, 0, 1, cancellationToken).ConfigureAwait(false);
            if (n == 0)
            {
                return null;
            }

            headerBytes.Add(single[0]);
            int count = headerBytes.Count;
            if (count >= 4
                && headerBytes[count - 4] == '\r'
                && headerBytes[count - 3] == '\n'
                && headerBytes[count - 2] == '\r'
                && headerBytes[count - 1] == '\n')
            {
                terminatorLength = 4;
                break;
            }

            if (count >= 2
                && headerBytes[count - 2] == '\n'
                && headerBytes[count - 1] == '\n')
            {
                terminatorLength = 2;
                break;
            }

            if (count >= MaxHeaderBytes)
            {
                throw new InvalidDataException($"RPC header exceeded {MaxHeaderBytes} bytes.");
            }
        }

        string headerText = Encoding.ASCII.GetString(headerBytes.ToArray(), 0, headerBytes.Count - terminatorLength);
        int contentLength = ParseContentLength(headerText);

        byte[] payload = new byte[contentLength];
        int filled = 0;
        while (filled < contentLength)
        {
            int read = await input.ReadAsync(payload, filled, contentLength - filled, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return null;
            }
            filled += read;
        }

        return payload;
    }

    private static int ParseContentLength(string headerText)
    {
        int contentLength = -1;
        foreach (var rawLine in headerText.Split('\n'))
        {
            string line = rawLine.Trim('\r', ' ');
            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(
                        line.Substring("Content-Length:".Length).Trim(),
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out var parsed))
                {
                    contentLength = parsed;
                    break;
                }
            }
        }

        if (contentLength < 0 || contentLength > MaxContentLength)
        {
            throw new InvalidDataException($"Missing or invalid Content-Length header: {contentLength}");
        }

        return contentLength;
    }

    private static async Task<byte[]?> ReadFrameAsync(Stream input, StreamFrameBuffer state, CancellationToken cancellationToken)
    {
        int headerEndIdx = -1;
        int sepLen = 4;

        while (true)
        {
            if (state.Count > 0 && TryFindHeaderTerminator(state.Buffer, state.Offset, state.Count, out headerEndIdx, out sepLen))
            {
                break;
            }

            if (state.Count >= MaxHeaderBytes)
            {
                state.Count = 0;
                state.Offset = 0;
                throw new InvalidDataException($"RPC header exceeded {MaxHeaderBytes} bytes.");
            }

            if (state.Offset + state.Count == state.Buffer.Length)
            {
                if (state.Offset > 0)
                {
                    System.Buffer.BlockCopy(state.Buffer, state.Offset, state.Buffer, 0, state.Count);
                    state.Offset = 0;
                }
                else
                {
                    Array.Resize(ref state.Buffer, Math.Max(state.Buffer.Length * 2, MaxHeaderBytes + 64));
                }
            }

            int n = await input.ReadAsync(state.Buffer, state.Offset + state.Count, state.Buffer.Length - (state.Offset + state.Count), cancellationToken).ConfigureAwait(false);
            if (n == 0)
            {
                return null;
            }
            state.Count += n;
        }

        string headerText = Encoding.ASCII.GetString(state.Buffer, state.Offset, headerEndIdx);
        state.Consume(headerEndIdx + sepLen);

        int contentLength = ParseContentLength(headerText);

        byte[] payload = new byte[contentLength];
        int filled = 0;
        if (state.Count > 0)
        {
            int copyNow = Math.Min(state.Count, contentLength);
            System.Buffer.BlockCopy(state.Buffer, state.Offset, payload, 0, copyNow);
            state.Consume(copyNow);
            filled = copyNow;
        }

        while (filled < contentLength)
        {
            int read = await input.ReadAsync(payload, filled, contentLength - filled, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return null;
            }
            filled += read;
        }
        return payload;
    }

    private static bool TryFindHeaderTerminator(byte[] buf, int offset, int count, out int headerLength, out int sepLen)
    {
        for (int i = 0; i <= count - 2; i++)
        {
            int p = offset + i;
            if (i <= count - 4 && buf[p] == '\r' && buf[p + 1] == '\n' && buf[p + 2] == '\r' && buf[p + 3] == '\n')
            {
                headerLength = i;
                sepLen = 4;
                return true;
            }
            if (buf[p] == '\n' && buf[p + 1] == '\n')
            {
                headerLength = i;
                sepLen = 2;
                return true;
            }
        }
        headerLength = -1;
        sepLen = 0;
        return false;
    }

    private async Task WriteSuccessResponseAsync(Stream output, object? idVal, object? result, CancellationToken ct)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            jsonrpc = "2.0",
            id = idVal,
            result,
        }, JsonOptions);

        await WriteRawJsonFrameAsync(output, body, ct).ConfigureAwait(false);
    }

    private async Task WriteErrorResponseObjectAsync(Stream output, object? idVal, int code, string message, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        using (var jw = new Utf8JsonWriter(ms))
        {
            jw.WriteStartObject();
            jw.WriteString("jsonrpc", "2.0");
            if (idVal is long l) jw.WriteNumber("id", l);
            else if (idVal is double d) jw.WriteNumber("id", d);
            else if (idVal is string s) jw.WriteString("id", s);
            else jw.WriteNull("id");
            jw.WriteStartObject("error");
            jw.WriteNumber("code", code);
            jw.WriteString("message", message);
            jw.WriteEndObject();
            jw.WriteEndObject();
        }
        await WriteRawJsonFrameAsync(output, ms.ToArray(), ct).ConfigureAwait(false);
    }

    private async Task WriteRawJsonFrameAsync(Stream output, byte[] body, CancellationToken ct)
    {
        byte[] header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await output.WriteAsync(header, 0, header.Length, ct).ConfigureAwait(false);
            await output.WriteAsync(body, 0, body.Length, ct).ConfigureAwait(false);
            await output.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static string? GetStringParam(JsonElement paramsEl, string propName)
    {
        if (paramsEl.ValueKind == JsonValueKind.Object &&
            paramsEl.TryGetProperty(propName, out var prop) &&
            prop.ValueKind == JsonValueKind.String)
        {
            return prop.GetString();
        }
        return null;
    }
}
