using System;
using System.Collections.Generic;
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
        while (!cancellationToken.IsCancellationRequested)
        {
            var payload = await ReadFrameAsync(input, cancellationToken).ConfigureAwait(false);
            if (payload == null)
            {
                break;
            }

            if (payload.Length == 0)
            {
                continue;
            }

            bool shouldStop = false;
            try
            {
                using var doc = JsonDocument.Parse(payload);
                var root = doc.RootElement;
                string? method = root.TryGetProperty("method", out var mEl) ? mEl.GetString() : null;
                bool hasId = root.TryGetProperty("id", out var idEl);
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
                                     paramsEl.TryGetProperty("force", out var fEl) &&
                                     fEl.ValueKind == JsonValueKind.True;
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
                        string? guid = GetStringParam(paramsEl, "scriptGuid");
                        string? className = GetStringParam(paramsEl, "className");
                        string methodName = GetStringParam(paramsEl, "methodName") ?? string.Empty;
                        var locations = _cache.FindByMethod(guid, className, methodName);
                        result = new { locations };
                        break;
                    }

                    case "inspector/getSerializedValues":
                    {
                        string guid = GetStringParam(paramsEl, "scriptGuid") ?? string.Empty;
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
                        await WriteErrorResponseAsync(output, idEl, errorCode, errorMsg, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        await WriteSuccessResponseAsync(output, idEl, result, cancellationToken).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception ex)
            {
                try
                {
                    await WriteRawJsonFrameAsync(
                        output,
                        JsonSerializer.SerializeToUtf8Bytes(new
                        {
                            jsonrpc = "2.0",
                            id = (object?)null,
                            error = new { code = -32603, message = ex.Message },
                        }, JsonOptions),
                        cancellationToken).ConfigureAwait(false);
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

    public static byte[] EncodeFrame(object payloadObject)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(payloadObject, JsonOptions);
        byte[] header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        byte[] combined = new byte[header.Length + body.Length];
        Buffer.BlockCopy(header, 0, combined, 0, header.Length);
        Buffer.BlockCopy(body, 0, combined, header.Length, body.Length);
        return combined;
    }

    public static async Task<byte[]?> ReadFrameAsync(Stream input, CancellationToken cancellationToken)
    {
        var headerBytes = new List<byte>(64);
        var single = new byte[1];

        while (true)
        {
            int n = await input.ReadAsync(single, 0, 1, cancellationToken).ConfigureAwait(false);
            if (n == 0)
            {
                return null;
            }
            headerBytes.Add(single[0]);
            int len = headerBytes.Count;
            if (len >= 4 &&
                headerBytes[len - 4] == '\r' &&
                headerBytes[len - 3] == '\n' &&
                headerBytes[len - 2] == '\r' &&
                headerBytes[len - 1] == '\n')
            {
                break;
            }
            if (len >= 2 &&
                headerBytes[len - 2] == '\n' &&
                headerBytes[len - 1] == '\n')
            {
                break;
            }
            if (len > 8192)
            {
                throw new InvalidDataException("RPC header exceeded 8192 bytes.");
            }
        }

        string headerText = Encoding.ASCII.GetString(headerBytes.ToArray());
        int contentLength = -1;
        foreach (var rawLine in headerText.Split('\n'))
        {
            string line = rawLine.Trim('\r', ' ');
            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
            {
                if (int.TryParse(line.Substring("Content-Length:".Length).Trim(), out var parsed))
                {
                    contentLength = parsed;
                    break;
                }
            }
        }

        if (contentLength < 0)
        {
            throw new InvalidDataException("Missing Content-Length header.");
        }

        byte[] buffer = new byte[contentLength];
        int offset = 0;
        while (offset < contentLength)
        {
            int read = await input.ReadAsync(buffer, offset, contentLength - offset, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return null;
            }
            offset += read;
        }
        return buffer;
    }

    private async Task WriteSuccessResponseAsync(Stream output, JsonElement idEl, object? result, CancellationToken ct)
    {
        object idVal = idEl.ValueKind switch
        {
            JsonValueKind.Number => idEl.GetInt64(),
            JsonValueKind.String => idEl.GetString()!,
            _ => null!,
        };

        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            jsonrpc = "2.0",
            id = idVal,
            result,
        }, JsonOptions);

        await WriteRawJsonFrameAsync(output, body, ct).ConfigureAwait(false);
    }

    private async Task WriteErrorResponseAsync(Stream output, JsonElement idEl, int code, string message, CancellationToken ct)
    {
        object idVal = idEl.ValueKind switch
        {
            JsonValueKind.Number => idEl.GetInt64(),
            JsonValueKind.String => idEl.GetString()!,
            _ => null!,
        };

        byte[] body = JsonSerializer.SerializeToUtf8Bytes(new
        {
            jsonrpc = "2.0",
            id = idVal,
            error = new { code, message },
        }, JsonOptions);

        await WriteRawJsonFrameAsync(output, body, ct).ConfigureAwait(false);
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
