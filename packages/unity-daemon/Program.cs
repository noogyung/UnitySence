using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using UnityBrain.Daemon.Cache;

namespace UnityBrain.Daemon;

public static class DaemonEntry
{
    public static async Task<int> Main(string[] args)
    {
        string projectRoot = Directory.GetCurrentDirectory();
        string? cacheDir = null;
        bool oneShotIndex = false;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--project-root" && i + 1 < args.Length)
            {
                projectRoot = Path.GetFullPath(args[++i]);
            }
            else if (args[i] == "--cache-dir" && i + 1 < args.Length)
            {
                cacheDir = Path.GetFullPath(args[++i]);
            }
            else if (args[i] == "--oneshot-index")
            {
                oneShotIndex = true;
            }
        }

        cacheDir ??= Path.Combine(projectRoot, "Library", "UnityBrainCache");
        Directory.CreateDirectory(cacheDir);
        string cacheFilePath = Path.Combine(cacheDir, "asset-index.bin");

        var cache = new BinaryIndexCache();
        cache.BuildOrUpdateIndex(projectRoot, cacheFilePath, forceRebuild: false);

        if (oneShotIndex)
        {
            return 0;
        }

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        var server = new RpcServer(cache, projectRoot, cacheFilePath);
        using var stdin = Console.OpenStandardInput();
        using var stdout = Console.OpenStandardOutput();
        await server.RunAsync(stdin, stdout, cts.Token).ConfigureAwait(false);
        return 0;
    }
}
