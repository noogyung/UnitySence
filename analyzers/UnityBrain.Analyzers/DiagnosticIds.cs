using Microsoft.CodeAnalysis;

namespace UnityBrain.Analyzers;

public static class DiagnosticIds
{
    public const string CategoryPerformance = "UnityBrain.Performance";
    public const string CategoryBurst = "UnityBrain.Burst";
    public const string CategoryValidation = "UnityBrain.Validation";
    public const string CategorySerialization = "UnityBrain.Serialization";

    public const string IndirectPerformanceCriticalInvocation = "UB1001";
    public const string UncachedComponentLookup = "UB1002";
    public const string UncachedShaderOrAnimatorPropertyId = "UB1003";

    public const string BurstReferenceTypeForbidden = "UB2001";
    public const string BurstBoxingForbidden = "UB2002";
    public const string BurstManagedStringForbidden = "UB2003";
    public const string BurstExceptionHandlingForbidden = "UB2004";

    public const string UnresolvedInvokeOrCoroutineMethod = "UB3001";
    public const string UnknownUnityTagOrLayer = "UB3002";
    public const string SceneNotInBuildSettings = "UB3003";

    public const string FormerlySerializedAsSuggested = "UB4001";

    public static readonly DiagnosticDescriptor UB1001Rule = new(
        id: IndirectPerformanceCriticalInvocation,
        title: "[UnityBrain] 성능 민감 경로 내 고비용 유니티 API 간접 호출 지양",
        messageFormat: "[UnityBrain] 성능 민감 호출 경로({1})에서 고비용 유니티 API '{0}'이(가) 호출되었습니다.",
        category: CategoryPerformance,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Update, FixedUpdate, LateUpdate, OnGUI, OnRenderObject에서 도달 가능한 메서드는 매 프레임 실행되므로 반복 탐색이나 메모리 할당을 피해야 합니다.");

    public static readonly DiagnosticDescriptor UB1002Rule = new(
        id: UncachedComponentLookup,
        title: "[UnityBrain] 성능 민감 루프 밖에서 GetComponent/TryGetComponent 결과 캐싱 권장",
        messageFormat: "[UnityBrain] 성능 민감 컨텍스트({1})에서 캐싱되지 않은 '{0}' 호출이 감지되었습니다. Awake()에서 컴포넌트 참조를 캐싱하세요.",
        category: CategoryPerformance,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Awake()에서 컴포넌트 참조를 미리 캐싱하면 매 프레임 GetComponent 호출 오버헤드를 제거할 수 있습니다.");

    public static readonly DiagnosticDescriptor UB1003Rule = new(
        id: UncachedShaderOrAnimatorPropertyId,
        title: "[UnityBrain] 문자열 리터럴 대신 캐싱된 Shader.PropertyToID 또는 Animator.StringToHash 사용 권장",
        messageFormat: "[UnityBrain] {1}에서 문자열 리터럴 \"{0}\"이(가) 사용되었습니다. {2}로 static readonly int 필드에 캐싱하세요.",
        category: CategoryPerformance,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Shader 및 Animator 프로퍼티 설정 메서드는 ID를 캐싱하지 않으면 매 호출마다 문자열 해시를 다시 계산합니다.");

    public static readonly DiagnosticDescriptor UB2001Rule = new(
        id: BurstReferenceTypeForbidden,
        title: "[UnityBrain] Burst 컴파일 코드에서 관리되는 참조 타입 사용 금지",
        messageFormat: "[UnityBrain] [BurstCompile] 컨텍스트 내부에서 참조 타입 '{0}'은(는) 사용할 수 없습니다.",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Burst 컴파일러는 비관리 blittable 값 타입과 NativeContainer만 지원합니다.");

    public static readonly DiagnosticDescriptor UB2002Rule = new(
        id: BurstBoxingForbidden,
        title: "[UnityBrain] Burst 컴파일 코드에서 값 타입 박싱(Boxing) 금지",
        messageFormat: "[UnityBrain] [BurstCompile] 컨텍스트 내부에서 값 타입 '{0}'이(가) '{1}'(으)로 박싱됩니다.",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "박싱은 관리 힙 할당을 유발하므로 Burst 컴파일러에서 거부됩니다.");

    public static readonly DiagnosticDescriptor UB2003Rule = new(
        id: BurstManagedStringForbidden,
        title: "[UnityBrain] Burst 컴파일 코드에서 관리 문자열 연산 금지",
        messageFormat: "[UnityBrain] [BurstCompile] 컨텍스트 내부에서 관리 문자열 연산({0})은 허용되지 않습니다.",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "FixedString 타입을 사용하거나 로깅 코드를 [BurstDiscard] 메서드로 분리하세요.");

    public static readonly DiagnosticDescriptor UB2004Rule = new(
        id: BurstExceptionHandlingForbidden,
        title: "[UnityBrain] Burst 컴파일 코드에서 try/catch 및 throw 예외 처리 미지원",
        messageFormat: "[UnityBrain] [BurstCompile] 컨텍스트 내부에서 예외 처리 구문 '{0}'은(는) 지원되지 않습니다.",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Burst 컴파일러는 try/catch 및 관리되는 예외 처리를 지원하지 않습니다.");

    public static readonly DiagnosticDescriptor UB3001Rule = new(
        id: UnresolvedInvokeOrCoroutineMethod,
        title: "[UnityBrain] Invoke/StartCoroutine 대상 메서드 누락 또는 반환 타입 불일치",
        messageFormat: "{0}",
        category: CategoryValidation,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "문자열로 지정한 메서드 이름이 대상 클래스 또는 상위 클래스에 선언되어 있는지 검사합니다.");

    public static readonly DiagnosticDescriptor UB3002Rule = new(
        id: UnknownUnityTagOrLayer,
        title: "[UnityBrain] ProjectSettings에 등록되지 않은 유니티 태그/레이어 이름",
        messageFormat: "[UnityBrain] {0} '{1}'은(는) ProjectSettings/TagManager.asset에 등록되어 있지 않습니다.",
        category: CategoryValidation,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "ProjectSettings 캐시(AdditionalFiles)를 기준으로 문자열 태그와 레이어 이름을 검증합니다.");

    public static readonly DiagnosticDescriptor UB3003Rule = new(
        id: SceneNotInBuildSettings,
        title: "[UnityBrain] EditorBuildSettings에 활성화되지 않은 씬 이름 또는 경로",
        messageFormat: "[UnityBrain] 씬 '{0}'은(는) EditorBuildSettings.asset의 활성화된 빌드 씬 목록에 없습니다.",
        category: CategoryValidation,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "SceneManager.LoadScene 문자열 인자를 ProjectSettings 캐시의 빌드 씬 목록과 대조 검증합니다.");

    public static readonly SuppressionDescriptor SuppressCS0649Rule = new(
        id: "UBSUP0001",
        suppressedDiagnosticId: "CS0649",
        justification: "[UnityBrain] Unity 직렬화 필드([SerializeField]/[SerializeReference])는 인스펙터에서 할당됩니다.");

    public static readonly SuppressionDescriptor SuppressCS0169Rule = new(
        id: "UBSUP0002",
        suppressedDiagnosticId: "CS0169",
        justification: "[UnityBrain] Unity 직렬화 필드는 엔진에서 암시적으로 사용됩니다.");

    public static readonly SuppressionDescriptor SuppressIDE0051Rule = new(
        id: "UBSUP0003",
        suppressedDiagnosticId: "IDE0051",
        justification: "[UnityBrain] Unity 이벤트 함수 및 직렬화 필드는 엔진 런타임에서 호출/사용됩니다.");
}
