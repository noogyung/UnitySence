using System;
using System.Linq;
using System.Threading.Tasks;
using UnityBrain.Analyzers.CodeFixes;
using UnityBrain.Analyzers.Diagnostics;

namespace UnityBrain.Analyzers.Tests;

public sealed class UnityStringValidationAnalyzerTests
{
    private const string SampleProjectSettingsJson = @"
{
  ""schemaVersion"": 1,
  ""updatedAt"": ""2026-11-16T00:00:00Z"",
  ""tags"": [""Untagged"", ""Player"", ""Enemy""],
  ""layers"": [
    { ""index"": 0, ""name"": ""Default"" },
    { ""index"": 8, ""name"": ""Enemy"" }
  ],
  ""sortingLayers"": [{ ""id"": 0, ""name"": ""Default"" }],
  ""inputAxes"": [],
  ""buildScenes"": [
    { ""path"": ""Assets/Scenes/MainMenu.unity"", ""name"": ""MainMenu"", ""guid"": ""aaa"", ""buildIndex"": 0, ""enabled"": true },
    { ""path"": ""Assets/Scenes/Level1.unity"", ""name"": ""Level1"", ""guid"": ""bbb"", ""buildIndex"": 1, ""enabled"": true },
    { ""path"": ""Assets/Scenes/DevTest.unity"", ""name"": ""DevTest"", ""guid"": ""ccc"", ""buildIndex"": -1, ""enabled"": false }
  ],
  ""animatorControllers"": []
}
";

    [Fact]
    public async Task DetectsUnresolvedInvokeAndNonEnumeratorCoroutineTargets()
    {
        const string code = @"
using System.Collections;
using UnityEngine;

public class BaseActor : MonoBehaviour
{
    protected void BaseHelper() {}
}

public class PlayerActor : BaseActor
{
    private void Start()
    {
        Invoke(""MissingMethod"", 1.0f);
        StartCoroutine(""MissingCoroutine"");
        StartCoroutine(""NotAnEnumerator"");

        Invoke(""ValidTarget"", 0.5f);
        Invoke(""BaseHelper"", 0.5f);
        StartCoroutine(""ValidRoutine"");
    }

    private void ValidTarget() {}
    private void NotAnEnumerator() {}

    private IEnumerator ValidRoutine()
    {
        yield break;
    }
}
";

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            code,
            new UnityStringValidationAnalyzer());

        var ub3001 = diags.Where(d => d.Id == DiagnosticIds.UnresolvedInvokeOrCoroutineMethod).ToArray();
        AssertEx.Equal(3, ub3001.Length, $"Expected 3 UB3001 diagnostics, got {ub3001.Length}");
    }

    [Fact]
    public async Task ValidatesUnityTagsAndLayersAgainstProjectSettingsJson()
    {
        const string code = @"
using UnityEngine;

public class TagAndLayerCheck : MonoBehaviour
{
    private void Check(GameObject go)
    {
        if (go.CompareTag(""UnknownTag"")) {}
        if (go.CompareTag(""Player"")) {}

        var foundBad = GameObject.FindWithTag(""Phantom"");
        var foundOk = GameObject.FindWithTag(""Enemy"");

        go.tag = ""BadAssignedTag"";
        if (go.tag == ""WrongEqTag"") {}
        go.tag = ""Player"";

        int badLayer = LayerMask.NameToLayer(""NonExistentLayer"");
        int goodLayer = LayerMask.NameToLayer(""Default"");
        int mask = LayerMask.GetMask(""Default"", ""MissingMaskLayer"");
    }
}
";

        var settingsFile = new InMemoryAdditionalText(
            "D:/FakeProject/Library/UnityBrainCache/project-settings.json",
            SampleProjectSettingsJson);

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            code,
            new UnityStringValidationAnalyzer(),
            new[] { settingsFile });

        var ub3002 = diags.Where(d => d.Id == DiagnosticIds.UnknownUnityTagOrLayer).ToArray();
        AssertEx.Equal(6, ub3002.Length, $"Expected 6 UB3002 diagnostics, got {ub3002.Length}");
    }

    [Fact]
    public async Task ValidatesSceneManagerLoadSceneAgainstEnabledBuildScenes()
    {
        const string code = @"
using UnityEngine;
using UnityEngine.SceneManagement;

public class SceneLoader : MonoBehaviour
{
    public void LoadAll()
    {
        SceneManager.LoadScene(""MainMenu"");
        SceneManager.LoadSceneAsync(""Assets/Scenes/Level1.unity"");
        SceneManager.LoadScene(""DevTest"");
        SceneManager.LoadSceneAsync(""UnknownScene"");
    }
}
";

        var settingsFile = new InMemoryAdditionalText(
            "D:/FakeProject/Library/UnityBrainCache/project-settings.json",
            SampleProjectSettingsJson);

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            code,
            new UnityStringValidationAnalyzer(),
            new[] { settingsFile });

        var ub3003 = diags.Where(d => d.Id == DiagnosticIds.SceneNotInBuildSettings).ToArray();
        AssertEx.Equal(2, ub3003.Length, $"Expected 2 UB3003 diagnostics (disabled + unknown), got {ub3003.Length}");
    }

    [Fact]
    public async Task FormerlySerializedAsRefactoringAddsAttributeAndSkipsNonSerializedFields()
    {
        const string code = @"
using UnityEngine;

public class PlayerConfig : MonoBehaviour
{
    [SerializeField]
    private float moveSpeed = 5f;

    private int _runtimeOnly = 0;
}
";

        int moveSpeedPos = code.IndexOf("moveSpeed", StringComparison.Ordinal);
        var updated = await RoslynTestHarness.ApplyCodeRefactoringAsync(
            code,
            moveSpeedPos,
            new FormerlySerializedAsRefactoringProvider());

        AssertEx.Contains("using UnityEngine.Serialization;", updated);
        AssertEx.Contains("[FormerlySerializedAs(\"moveSpeed\")]", updated);

        int runtimeOnlyPos = code.IndexOf("_runtimeOnly", StringComparison.Ordinal);
        bool threwNoAction = false;
        try
        {
            await RoslynTestHarness.ApplyCodeRefactoringAsync(
                code,
                runtimeOnlyPos,
                new FormerlySerializedAsRefactoringProvider());
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("zero actions"))
        {
            threwNoAction = true;
        }
        AssertEx.True(threwNoAction, "Expected no FormerlySerializedAs refactoring on non-serialized private field.");
    }

    [Fact]
    public async Task ValidatesTagsLayersAndBuildScenesDirectlyFromUnityAssetYamlFiles()
    {
        const string tagManagerAsset = @"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!78 &1
TagManager:
  serializedVersion: 2
  tags:
  - Enemy
  - Interactable
  layers:
  - Default
  -
  -
  - Hitbox
  m_SortingLayers:
  - name: Default
";
        const string editorBuildSettingsAsset = @"%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1045 &1
EditorBuildSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Scenes:
  - enabled: 1
    path: Assets/Scenes/MainMenu.unity
    guid: 11111111111111111111111111111111
  - enabled: 0
    path: Assets/Scenes/DisabledTest.unity
    guid: 22222222222222222222222222222222
";
        const string code = @"
using UnityEngine;
using UnityEngine.SceneManagement;

public class DirectYamlValidation : MonoBehaviour
{
    private void Check(GameObject go)
    {
        if (go.CompareTag(""Player"")) {}
        if (go.CompareTag(""Interactable"")) {}
        if (go.CompareTag(""NoSuchTag"")) {}

        int okLayer = LayerMask.NameToLayer(""Hitbox"");
        int badLayer = LayerMask.NameToLayer(""MissingLayer"");

        SceneManager.LoadScene(""MainMenu"");
        SceneManager.LoadScene(""DisabledTest"");
        SceneManager.LoadScene(""GhostScene"");
    }
}
";
        var tagFile = new InMemoryAdditionalText("D:/SampleUnityProject/ProjectSettings/TagManager.asset", tagManagerAsset);
        var sceneFile = new InMemoryAdditionalText("D:/SampleUnityProject/ProjectSettings/EditorBuildSettings.asset", editorBuildSettingsAsset);

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            code,
            new UnityStringValidationAnalyzer(),
            new[] { tagFile, sceneFile });

        var ub3002 = diags.Where(d => d.Id == DiagnosticIds.UnknownUnityTagOrLayer).ToArray();
        var ub3003 = diags.Where(d => d.Id == DiagnosticIds.SceneNotInBuildSettings).ToArray();
        AssertEx.Equal(2, ub3002.Length, $"Expected 2 UB3002 diagnostics from TagManager.asset, got {ub3002.Length}");
        AssertEx.Equal(2, ub3003.Length, $"Expected 2 UB3003 diagnostics from EditorBuildSettings.asset, got {ub3003.Length}");
    }

    [Fact]
    public async Task AllowsBuiltinLayersAndDetectsStopCoroutineAndGetSceneByName()
    {
        const string tagManagerAsset = @"%YAML 1.1
--- !u!78 &1
TagManager:
  tags: []
  layers: []
";
        const string editorBuildSettingsAsset = @"%YAML 1.1
--- !u!1045 &1
EditorBuildSettings:
  m_Scenes:
  - enabled: 1
    path: Assets/Scenes/Lobby.unity
    guid: 11111111111111111111111111111111
";
        const string code = @"
using UnityEngine;
using UnityEngine.SceneManagement;

public class CoroutineAndSceneTest : MonoBehaviour
{
    private void Run()
    {
        int uiLayer = LayerMask.NameToLayer(""UI"");
        _ = uiLayer;
        StopCoroutine(""MissingRoutine"");
        _ = SceneManager.GetSceneByName(""MissingScene"");
    }
}";
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            code,
            new UnityStringValidationAnalyzer(),
            new[]
            {
                new InMemoryAdditionalText("D:/SampleUnityProject/ProjectSettings/TagManager.asset", tagManagerAsset),
                new InMemoryAdditionalText("D:/SampleUnityProject/ProjectSettings/EditorBuildSettings.asset", editorBuildSettingsAsset),
            });

        var ub3001 = diags.Where(d => d.Id == DiagnosticIds.UnresolvedInvokeOrCoroutineMethod).ToArray();
        var ub3002 = diags.Where(d => d.Id == DiagnosticIds.UnknownUnityTagOrLayer).ToArray();
        var ub3003 = diags.Where(d => d.Id == DiagnosticIds.SceneNotInBuildSettings).ToArray();

        AssertEx.Equal(0, ub3002.Length, "UI builtin layer should not trigger UB3002");
        AssertEx.Equal(1, ub3001.Length, "StopCoroutine missing routine should trigger UB3001");
        AssertEx.Equal(1, ub3003.Length, "SceneManager.GetSceneByName missing scene should trigger UB3003");
    }

    [Fact]
    public async Task SuppressesCompilerWarningsOnSerializeFieldInMonoBehaviour()
    {
        const string code = @"
using UnityEngine;

public class FieldSuppressSample : MonoBehaviour
{
    [SerializeField]
    private int _serializedReadOnly;

    [SerializeField]
    private int _serializedNeverUsed;

    private int _plainReadOnly;
    private int _plainNeverUsed;

    public int ReadValues() => _serializedReadOnly + _plainReadOnly;
}";

        var diags = await RoslynTestHarness.GetDiagnosticsWithSuppressorAsync(
            code,
            new UnityImplicitUsageSuppressor());

        var cs0649 = diags.Where(d => d.Id == "CS0649").ToArray();
        var cs0169 = diags.Where(d => d.Id == "CS0169").ToArray();
        string dump = string.Join(" | ", diags.Select(d => $"{d.Id}(sup={d.IsSuppressed}):{d.GetMessage()}"));

        AssertEx.True(cs0649.Any(d => d.GetMessage().Contains("_serializedReadOnly") && d.IsSuppressed),
            $"Expected CS0649 on [SerializeField] _serializedReadOnly to be suppressed. Diags: {dump}");
        AssertEx.True(cs0649.Any(d => d.GetMessage().Contains("_plainReadOnly") && !d.IsSuppressed),
            $"Expected CS0649 on plain _plainReadOnly NOT to be suppressed. Diags: {dump}");
        AssertEx.True(cs0169.Any(d => d.GetMessage().Contains("_serializedNeverUsed") && d.IsSuppressed),
            $"Expected CS0169 on [SerializeField] _serializedNeverUsed to be suppressed. Diags: {dump}");
        AssertEx.True(cs0169.Any(d => d.GetMessage().Contains("_plainNeverUsed") && !d.IsSuppressed),
            $"Expected CS0169 on plain _plainNeverUsed NOT to be suppressed. Diags: {dump}");
    }

    [Fact]
    public async Task SimpleJsonParsesBomPrefixedJsonCleanly()
    {
        var parsed = UnityBrain.Analyzers.Json.SimpleJson.Parse("\uFEFF{\"key\":\"val\"}");
        AssertEx.True(parsed is System.Collections.Generic.Dictionary<string, object?>,
            "Expected SimpleJson.Parse to return Dictionary for BOM-prefixed JSON object");
        var dict = (System.Collections.Generic.Dictionary<string, object?>)parsed!;
        AssertEx.True(dict.TryGetValue("key", out var value), "Expected key 'key' to exist");
        AssertEx.Equal("val", value as string);

        const string code = @"
using UnityEngine;

public class BomSettingsCheck : MonoBehaviour
{
    private void Check(GameObject go)
    {
        _ = go.CompareTag(""Player"");
    }
}";
        var bomSettings = new InMemoryAdditionalText(
            "D:/FakeProject/Library/UnityBrainCache/project-settings.json",
            "\uFEFF" + SampleProjectSettingsJson);
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            code,
            new UnityStringValidationAnalyzer(),
            new[] { bomSettings });
        var ub3002 = diags.Where(d => d.Id == DiagnosticIds.UnknownUnityTagOrLayer).ToArray();
        AssertEx.Equal(0, ub3002.Length, "BOM-prefixed project-settings.json should recognize 'Player' tag");
    }
}
