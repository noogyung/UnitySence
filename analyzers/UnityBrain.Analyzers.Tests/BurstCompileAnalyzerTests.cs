using System.Linq;
using System.Threading.Tasks;
using UnityBrain.Analyzers.Diagnostics;

namespace UnityBrain.Analyzers.Tests;

public sealed class BurstCompileAnalyzerTests
{
    [Fact]
    public async Task DetectsReferenceTypeAllocationAndFieldsInBurstStruct()
    {
        const string code = @"
using System.Collections.Generic;
using Unity.Burst;

[BurstCompile]
public struct BadBurstJob
{
    public List<int> ManagedList;

    public void Execute()
    {
        var temp = new object();
        int[] arr = new int[4];
    }
}
";

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, new BurstCompileAnalyzer());
        var ub2001 = diags.Where(d => d.Id == DiagnosticIds.BurstReferenceTypeForbidden).ToArray();
        AssertEx.True(ub2001.Length >= 3, $"Expected at least 3 UB2001 diagnostics, got {ub2001.Length}");
    }

    [Fact]
    public async Task DetectsValueTypeBoxingInBurstMethod()
    {
        const string code = @"
using System;
using Unity.Burst;
using UnityEngine;

public struct BoxingJob
{
    [BurstCompile]
    public void Execute(int count)
    {
        object boxed = count;
        IComparable cmp = 42;
        Debug.Log(count);
    }
}
";

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, new BurstCompileAnalyzer());
        var ub2002 = diags.Where(d => d.Id == DiagnosticIds.BurstBoxingForbidden).ToArray();
        AssertEx.Equal(3, ub2002.Length, $"Expected 3 UB2002 boxing diagnostics, got {ub2002.Length}");
    }

    [Fact]
    public async Task DetectsManagedStringOperationsAndTryCatchInBurstMethod()
    {
        const string code = @"
using System;
using Unity.Burst;

public static class StringAndExceptionBurst
{
    [BurstCompile]
    public static int Run(int value)
    {
        try
        {
            var a = $""value={value}"";
            var b = ""prefix_"" + ""suffix"";
            var c = string.Format(""{0}"", value);
            return a.Length + b.Length + c.Length;
        }
        catch (Exception)
        {
            return -1;
        }
    }
}
";

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, new BurstCompileAnalyzer());
        var ub2003 = diags.Where(d => d.Id == DiagnosticIds.BurstManagedStringForbidden).ToArray();
        var ub2004 = diags.Where(d => d.Id == DiagnosticIds.BurstExceptionHandlingForbidden).ToArray();

        AssertEx.Equal(3, ub2003.Length, $"Expected 3 UB2003 diagnostics, got {ub2003.Length}");
        AssertEx.Equal(1, ub2004.Length, $"Expected 1 UB2004 diagnostic, got {ub2004.Length}");
    }

    [Fact]
    public async Task AllowsValidBlittableMathAndBurstDiscardHelpers()
    {
        const string code = @"
using Unity.Burst;

[BurstCompile]
public struct ValidBurstJob
{
    public float Speed;

    public void Execute(ref float pos, float dt)
    {
        pos += Speed * dt;
        LogManagedDebug(pos);
    }

    [BurstDiscard]
    private static void LogManagedDebug(float pos)
    {
        var text = $""pos={pos}"";
        var arr = new int[2];
    }
}
";

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, new BurstCompileAnalyzer());
        AssertEx.Equal(0, diags.Length, $"Expected 0 diagnostics, got {diags.Length}");
    }
}
