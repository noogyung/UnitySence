import * as vscode from 'vscode';

export interface SemanticTokenColorCustomizations {
  enabled?: boolean;
  rules?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TextMateRule {
  name?: string;
  scope: string | string[];
  settings: {
    foreground?: string;
    fontStyle?: string;
  };
}

export interface TokenColorCustomizations {
  textMateRules?: TextMateRule[];
  [key: string]: unknown;
}

interface RiderHighlightingBackup {
  hadSemanticEnabled: boolean;
  previousSemanticEnabled?: boolean;
  previousSemanticRules: Record<string, unknown>;
  managedSemanticKeys: string[];
  hadTokenCustomizations: boolean;
  hadTextMateRules: boolean;
  previousTextMateRules?: TextMateRule[];
  hadCSharpBracketColorization?: boolean;
  previousCSharpBracketColorization?: boolean;
  hadCSharpSemanticHighlighting?: boolean;
  previousCSharpSemanticHighlighting?: boolean | 'configuredByTheme';
}

const BACKUP_STATE_KEY = 'unitySense.riderHighlighting.backup.v3';
const V2_BACKUP_STATE_KEY = 'unitySense.riderHighlighting.backup.v2';
const LEGACY_BACKUP_STATE_KEY = 'unitySense.riderHighlighting.backup.v1';
const MIGRATED_V113_KEY = 'unitySense.riderHighlighting.migratedV113';
const MANAGED_RULE_PREFIX = '[UnitySense Rider Dark]';

export const RIDER_STRUCT_DISTINCT_COLOR = '#E1BFFF';

/**
 * Complete C# + Unity ShaderLab/HLSL TextMate token rules faithfully matching
 * JetBrains Rider Dark without modifying any workbench or editor background colors.
 * Rule order is significant: more specific operator-expression keywords appear after
 * general operators so `=>` / `:` / `{}` stay `#BDBDBD` while `new` / `typeof` / `is` are `#6C95EB`.
 */
export const RIDER_DARK_TEXTMATE_RULES: readonly TextMateRule[] = Object.freeze([
  {
    name: `${MANAGED_RULE_PREFIX} C# & Shader Keywords`,
    scope: [
      'keyword.cs',
      'keyword.other.cs',
      'keyword.control.cs',
      'keyword.control.flow.cs',
      'keyword.control.loop.cs',
      'keyword.control.conditional.cs',
      'keyword.control.try.cs',
      'keyword.type.cs',
      'storage.type.cs',
      'storage.modifier.cs',
      'variable.language.this.cs',
      'variable.language.base.cs',
      'constant.language.null.cs',
      'constant.language.boolean.cs',
      'keyword.preprocessor.cs',
      'meta.preprocessor.cs',
      'punctuation.separator.hash.cs',
      'punctuation.definition.interpolation.begin.cs',
      'punctuation.definition.interpolation.end.cs',
      'keyword.control.shaderlab',
      'keyword.other.shaderlab',
      'keyword.control.hlsl',
      'storage.type.hlsl',
      'storage.modifier.hlsl',
      'keyword',
      'storage.type',
      'storage.modifier',
      'constant.language.boolean',
      'variable.language.this',
      'constant.language',
    ],
    settings: { foreground: '#6C95EB' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Classes, Structs & Namespaces`,
    scope: [
      'entity.name.type.cs',
      'entity.name.type.class.cs',
      'entity.name.type.struct.cs',
      'entity.name.type.record.cs',
      'entity.name.type.delegate.cs',
      'entity.name.type.namespace.cs',
      'storage.type.generic.cs',
      'storage.type.object.array.cs',
      'entity.name.function.preprocessor.cs',
      'entity.name.type.shaderlab',
      'support.type.hlsl',
      'entity.name.type.namespace',
      'entity.name.type.class',
      'entity.name.type.struct',
      'support.type.primitive',
      'support.class',
      'support.type.exception',
      'entity.name.type',
    ],
    settings: { foreground: '#C191FF' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Interfaces, Enums & Type Parameters`,
    scope: [
      'entity.name.type.interface.cs',
      'entity.name.type.enum.cs',
      'entity.name.type.type-parameter.cs',
      'entity.name.type.interface',
      'entity.name.type.enum',
    ],
    settings: { foreground: '#E1BFFF' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Fields, Properties & Constants`,
    scope: [
      'entity.name.variable.field.cs',
      'entity.name.variable.property.cs',
      'entity.name.variable.enum-member.cs',
      'entity.name.variable.event.cs',
      'variable.other.object.property.cs',
      'variable.other.enummember.cs',
      'variable.other.constant.cs',
      'support.variable.semantic.hlsl',
      'variable.other.property.shaderlab',
      'entity.name.variable.enum-member',
      'entity.name.variable.field',
      'entity.name.variable.property',
      'variable.other.object.property',
      'variable.other.enummember',
    ],
    settings: { foreground: '#65C3CC' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Methods & Functions`,
    scope: [
      'entity.name.function.cs',
      'support.function.cs',
      'entity.name.function.hlsl',
      'support.function.hlsl',
      'entity.name.function',
      'support.function.magic',
      'support.function.builtin',
    ],
    settings: { foreground: '#3ACC9B' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Parameters, Locals & Identifiers`,
    scope: [
      'variable.parameter.cs',
      'entity.name.variable.parameter.cs',
      'entity.name.variable.local.cs',
      'entity.name.variable.range-variable.cs',
      'entity.name.variable.tuple-element.cs',
      'variable.other.readwrite.cs',
      'variable.other.object.cs',
      'variable.parameter',
      'entity.name.variable.local',
    ],
    settings: { foreground: '#D0D0D0' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Operators, Arrows & Punctuation`,
    scope: [
      'keyword.operator.cs',
      'keyword.operator.arrow.cs',
      'keyword.operator',
      'keyword.other.unit',
      'punctuation.cs',
      'punctuation.accessor.cs',
      'punctuation.separator.colon.cs',
      'punctuation.separator.comma.cs',
      'punctuation.terminator.statement.cs',
      'punctuation.curlybrace.open.cs',
      'punctuation.curlybrace.close.cs',
      'punctuation.parenthesis.open.cs',
      'punctuation.parenthesis.close.cs',
      'punctuation.squarebracket.open.cs',
      'punctuation.squarebracket.close.cs',
      'punctuation.definition.typeparameters.begin.cs',
      'punctuation.definition.typeparameters.end.cs',
      'punctuation.parenthesis.open',
      'punctuation.parenthesis.close',
      'punctuation.terminator.statement',
    ],
    settings: { foreground: '#BDBDBD' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Operator Keywords (new, typeof, nameof, is, as, await)`,
    scope: [
      'keyword.operator.expression.new.cs',
      'keyword.operator.expression.typeof.cs',
      'keyword.operator.expression.sizeof.cs',
      'keyword.operator.expression.nameof.cs',
      'keyword.operator.expression.is.cs',
      'keyword.operator.expression.as.cs',
      'keyword.operator.expression.await.cs',
      'keyword.operator.expression.default.cs',
      'keyword.operator.expression.stackalloc.cs',
      'keyword.operator.expression.checked.cs',
      'keyword.operator.expression.unchecked.cs',
      'keyword.operator.expression.when.cs',
      'keyword.operator.expression.with.cs',
      'keyword.operator.expression.switch.cs',
      'keyword.operator.expression.await',
      'keyword.operator.expression.new',
      'keyword.operator.expression.instanceof',
      'keyword.operator.expression.typeof',
      'keyword.operator.expression.keyof',
      'keyword.operator.expression.in',
      'keyword.operator.expression.delete',
    ],
    settings: { foreground: '#6C95EB' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Strings & Escapes`,
    scope: [
      'string.quoted.double.cs',
      'string.quoted.single.cs',
      'string.interpolated.cs',
      'punctuation.definition.string.begin.cs',
      'punctuation.definition.string.end.cs',
      'string.quoted.double',
      'string.interpolated.double',
      'string.quoted.single',
      'meta.preprocessor.include',
      'string.interpolated.single',
      'string.template',
    ],
    settings: { foreground: '#C9A26D' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} String Escape Sequences`,
    scope: ['constant.character.escape.cs', 'constant.character.escape'],
    settings: { foreground: '#E1BFFF' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Numbers`,
    scope: ['constant.numeric.cs', 'constant.numeric'],
    settings: { foreground: '#ED94C0' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} Comments & Documentation`,
    scope: [
      'comment.cs',
      'comment.line.double-slash.cs',
      'comment.block.cs',
      'comment.block.documentation.cs',
      'punctuation.definition.comment.cs',
      'comment',
    ],
    settings: { foreground: '#85C46C' },
  },
  {
    name: `${MANAGED_RULE_PREFIX} XML Doc Comment Tags`,
    scope: [
      'comment.block.documentation.cs entity.name.tag',
      'comment.block.documentation.cs punctuation.definition.tag',
    ],
    settings: { foreground: '#569E45' },
  },
]);

export const RIDER_CSHARP_BASE_RULES: Readonly<Record<string, string>> = Object.freeze({
  'keyword:csharp': '#6C95EB',
  'controlKeyword:csharp': '#6C95EB',
  'keywordControl:csharp': '#6C95EB',
  'plainKeyword:csharp': '#6C95EB',
  'modifier:csharp': '#6C95EB',
  'preprocessorKeyword:csharp': '#6C95EB',
  'namespace:csharp': '#C191FF',
  'type:csharp': '#C191FF',
  'class:csharp': '#C191FF',
  'recordClass:csharp': '#C191FF',
  'struct:csharp': '#C191FF',
  'recordStruct:csharp': '#C191FF',
  'delegate:csharp': '#C191FF',
  'preprocessorText:csharp': '#C191FF',
  'macro:csharp': '#C191FF',
  'interface:csharp': '#E1BFFF',
  'enum:csharp': '#E1BFFF',
  'typeParameter:csharp': '#E1BFFF',
  'razorTransition:csharp': '#E1BFFF',
  'method:csharp': '#3ACC9B',
  'extensionMethod:csharp': '#3ACC9B',
  'function:csharp': '#3ACC9B',
  'field:csharp': '#65C3CC',
  'property:csharp': '#65C3CC',
  'enumMember:csharp': '#65C3CC',
  'event:csharp': '#65C3CC',
  'constant:csharp': '#65C3CC',
  'parameter:csharp': '#D0D0D0',
  'variable:csharp': '#D0D0D0',
  'label:csharp': '#D0D0D0',
  'operator:csharp': '#BDBDBD',
  'operatorOverloaded:csharp': '#3ACC9B',
  'punctuation:csharp': '#BDBDBD',
  'string:csharp': '#C9A26D',
  'stringVerbatim:csharp': '#C9A26D',
  'stringEscapeCharacter:csharp': '#E1BFFF',
  'regexp:csharp': '#E1BFFF',
  'number:csharp': '#ED94C0',
  'comment:csharp': '#85C46C',
  'xmlDocCommentText:csharp': '#85C46C',
  'xmlDocCommentComment:csharp': '#85C46C',
  'xmlDocCommentDelimiter:csharp': '#569E45',
  'xmlDocCommentName:csharp': '#569E45',
  'xmlDocCommentAttributeName:csharp': '#85C46C',
  'xmlDocCommentAttributeQuotes:csharp': '#C9A26D',
  'xmlDocCommentAttributeValue:csharp': '#C9A26D',
  'xmlDocCommentCDataSection:csharp': '#85C46C',
  'excludedCode:csharp': '#6E7681',
});

export function buildRiderCSharpSemanticRules(distinguishStructs: boolean): Record<string, string> {
  const structColor = distinguishStructs
    ? RIDER_STRUCT_DISTINCT_COLOR
    : RIDER_CSHARP_BASE_RULES['struct:csharp'];
  return {
    ...RIDER_CSHARP_BASE_RULES,
    'struct:csharp': structColor,
    'recordStruct:csharp': structColor,
  };
}

export function buildRiderTextMateRules(distinguishStructs: boolean): TextMateRule[] {
  const rules: TextMateRule[] = RIDER_DARK_TEXTMATE_RULES.map((rule) => {
    if (distinguishStructs && rule.name === `${MANAGED_RULE_PREFIX} Classes, Structs & Namespaces`) {
      const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
      return {
        ...rule,
        scope: scopes.filter((s) => s !== 'entity.name.type.struct.cs' && s !== 'entity.name.type.struct'),
        settings: { ...rule.settings },
      };
    }
    return {
      ...rule,
      scope: Array.isArray(rule.scope) ? [...rule.scope] : rule.scope,
      settings: { ...rule.settings },
    };
  });

  if (distinguishStructs) {
    rules.push({
      name: `${MANAGED_RULE_PREFIX} Distinguished Structs`,
      scope: ['entity.name.type.struct.cs', 'entity.name.type.struct'],
      settings: { foreground: RIDER_STRUCT_DISTINCT_COLOR },
    });
  }

  return rules;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedTextMateRule(rule: TextMateRule): boolean {
  return typeof rule?.name === 'string' && rule.name.startsWith(MANAGED_RULE_PREFIX);
}

export class RiderHighlightingManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly state?: vscode.Memento;
  private memoryBackup: RiderHighlightingBackup | undefined;
  private updating = false;

  constructor(context?: vscode.ExtensionContext) {
    this.state = context?.globalState;
  }

  public async initialize(): Promise<void> {
    await this.migrateLegacySettingsIfNeeded();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('unitySense.csharp.riderHighlighting.enabled') ||
          e.affectsConfiguration('unitySense.csharp.riderHighlighting.distinguishStructs')
        ) {
          void this.syncFromConfig();
        }
      }),
    );

    await this.syncFromConfig();
  }

  private async migrateLegacySettingsIfNeeded(): Promise<void> {
    if (!this.state) return;
    if (this.state.get<boolean>(MIGRATED_V113_KEY)) return;

    await this.state.update(MIGRATED_V113_KEY, true);
    const unityCfg = vscode.workspace.getConfiguration('unitySense');
    const inspected = unityCfg.inspect?.<boolean>('csharp.riderHighlighting.distinguishStructs');
    if (inspected?.globalValue === true) {
      await unityCfg.update(
        'csharp.riderHighlighting.distinguishStructs',
        undefined,
        vscode.ConfigurationTarget.Global,
      );
    }
  }

  public isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('csharp.riderHighlighting.enabled', false);
  }

  public shouldDistinguishStructs(): boolean {
    return vscode.workspace
      .getConfiguration('unitySense')
      .get<boolean>('csharp.riderHighlighting.distinguishStructs', false);
  }

  public async toggle(): Promise<boolean> {
    const next = !this.isEnabled();
    const unityCfg = vscode.workspace.getConfiguration('unitySense');
    await unityCfg.update('csharp.riderHighlighting.enabled', next, vscode.ConfigurationTarget.Global);
    await this.syncFromConfig();
    return next;
  }

  public async syncFromConfig(): Promise<void> {
    if (this.updating) return;
    this.updating = true;
    try {
      if (this.isEnabled()) {
        await this.applyOverlay(this.shouldDistinguishStructs());
      } else {
        await this.removeOverlayIfApplied();
      }
    } finally {
      this.updating = false;
    }
  }

  private getBackup(): RiderHighlightingBackup | undefined {
    if (!this.state) return this.memoryBackup;
    const v3 = this.state.get<RiderHighlightingBackup>(BACKUP_STATE_KEY);
    if (v3) return v3;
    const v2 = this.state.get<RiderHighlightingBackup>(V2_BACKUP_STATE_KEY);
    if (v2) return v2;
    const legacy = this.state.get<{
      hadEnabled: boolean;
      previousEnabled?: boolean;
      previousRules: Record<string, unknown>;
      managedKeys: string[];
    }>(LEGACY_BACKUP_STATE_KEY);
    if (!legacy) return undefined;
    return {
      hadSemanticEnabled: legacy.hadEnabled,
      previousSemanticEnabled: legacy.previousEnabled,
      previousSemanticRules: legacy.previousRules,
      managedSemanticKeys: legacy.managedKeys,
      hadTokenCustomizations: false,
      hadTextMateRules: false,
    };
  }

  private async setBackup(backup: RiderHighlightingBackup | undefined): Promise<void> {
    this.memoryBackup = backup;
    if (this.state) {
      await this.state.update(BACKUP_STATE_KEY, backup);
      if (backup === undefined) {
        await this.state.update(V2_BACKUP_STATE_KEY, undefined);
        await this.state.update(LEGACY_BACKUP_STATE_KEY, undefined);
      }
    }
  }

  private readGlobalSemanticCustomizations(): SemanticTokenColorCustomizations {
    const editorCfg = vscode.workspace.getConfiguration('editor');
    const inspected = editorCfg.inspect?.<SemanticTokenColorCustomizations>('semanticTokenColorCustomizations');
    const raw = inspected?.globalValue;
    if (isPlainObject(raw)) {
      return {
        ...raw,
        rules: isPlainObject(raw.rules) ? { ...raw.rules } : undefined,
      };
    }
    return {};
  }

  private readGlobalTokenCustomizations(): { exists: boolean; value: TokenColorCustomizations } {
    const editorCfg = vscode.workspace.getConfiguration('editor');
    const inspected = editorCfg.inspect?.<TokenColorCustomizations>('tokenColorCustomizations');
    const raw = inspected?.globalValue;
    if (isPlainObject(raw)) {
      return {
        exists: true,
        value: {
          ...raw,
          textMateRules: Array.isArray(raw.textMateRules) ? [...raw.textMateRules] : undefined,
        },
      };
    }
    return { exists: false, value: {} };
  }

  private readCSharpLanguageEditorOverrides(): {
    hadBracket: boolean;
    prevBracket?: boolean;
    hadSemantic: boolean;
    prevSemantic?: boolean | 'configuredByTheme';
  } {
    const csharpEditorCfg = vscode.workspace.getConfiguration('editor', { languageId: 'csharp' });
    const bracketInspected = csharpEditorCfg.inspect?.<boolean>('bracketPairColorization.enabled');
    const semanticInspected = csharpEditorCfg.inspect?.<boolean | 'configuredByTheme'>(
      'semanticHighlighting.enabled',
    );
    return {
      hadBracket: bracketInspected?.globalLanguageValue !== undefined,
      prevBracket: bracketInspected?.globalLanguageValue,
      hadSemantic: semanticInspected?.globalLanguageValue !== undefined,
      prevSemantic: semanticInspected?.globalLanguageValue,
    };
  }

  private async writeGlobalSemanticCustomizations(
    value: SemanticTokenColorCustomizations | undefined,
  ): Promise<void> {
    const editorCfg = vscode.workspace.getConfiguration('editor');
    await editorCfg.update('semanticTokenColorCustomizations', value, vscode.ConfigurationTarget.Global);
  }

  private async writeGlobalTokenCustomizations(
    value: TokenColorCustomizations | undefined,
  ): Promise<void> {
    const editorCfg = vscode.workspace.getConfiguration('editor');
    await editorCfg.update('tokenColorCustomizations', value, vscode.ConfigurationTarget.Global);
  }

  private async writeCSharpLanguageEditorOverrides(
    bracketPairEnabled: boolean | undefined,
    semanticHighlightingEnabled: boolean | 'configuredByTheme' | undefined,
  ): Promise<void> {
    const csharpEditorCfg = vscode.workspace.getConfiguration('editor', { languageId: 'csharp' });
    await csharpEditorCfg.update(
      'bracketPairColorization.enabled',
      bracketPairEnabled,
      vscode.ConfigurationTarget.Global,
      true,
    );
    await csharpEditorCfg.update(
      'semanticHighlighting.enabled',
      semanticHighlightingEnabled,
      vscode.ConfigurationTarget.Global,
      true,
    );
  }

  private async applyOverlay(distinguishStructs: boolean): Promise<void> {
    const currentSemantic = this.readGlobalSemanticCustomizations();
    const currentSemanticRules: Record<string, unknown> = isPlainObject(currentSemantic.rules)
      ? { ...currentSemantic.rules }
      : {};
    const targetSemanticRules = buildRiderCSharpSemanticRules(distinguishStructs);
    const managedSemanticKeys = Object.keys(targetSemanticRules);

    const { exists: hadTokenCustomizations, value: currentToken } = this.readGlobalTokenCustomizations();
    const existingUserTextMateRules = (currentToken.textMateRules ?? []).filter(
      (r) => !isManagedTextMateRule(r),
    );
    const targetTextMateRules = buildRiderTextMateRules(distinguishStructs);
    const csharpOverrides = this.readCSharpLanguageEditorOverrides();

    const existingBackup = this.getBackup();
    if (!existingBackup) {
      const previousSemanticRules: Record<string, unknown> = {};
      for (const key of managedSemanticKeys) {
        if (Object.prototype.hasOwnProperty.call(currentSemanticRules, key)) {
          previousSemanticRules[key] = currentSemanticRules[key];
        }
      }
      await this.setBackup({
        hadSemanticEnabled: Object.prototype.hasOwnProperty.call(currentSemantic, 'enabled'),
        previousSemanticEnabled: currentSemantic.enabled,
        previousSemanticRules,
        managedSemanticKeys,
        hadTokenCustomizations,
        hadTextMateRules: Array.isArray(currentToken.textMateRules),
        previousTextMateRules: Array.isArray(currentToken.textMateRules)
          ? [...existingUserTextMateRules]
          : undefined,
        hadCSharpBracketColorization: csharpOverrides.hadBracket,
        previousCSharpBracketColorization: csharpOverrides.prevBracket,
        hadCSharpSemanticHighlighting: csharpOverrides.hadSemantic,
        previousCSharpSemanticHighlighting: csharpOverrides.prevSemantic,
      });
    } else {
      const mergedKeys = Array.from(
        new Set([...existingBackup.managedSemanticKeys, ...managedSemanticKeys]),
      );
      const nextPreviousRules = { ...existingBackup.previousSemanticRules };
      for (const key of managedSemanticKeys) {
        if (
          !existingBackup.managedSemanticKeys.includes(key) &&
          Object.prototype.hasOwnProperty.call(currentSemanticRules, key)
        ) {
          nextPreviousRules[key] = currentSemanticRules[key];
        }
      }
      const needsBracketBackupInit = existingBackup.hadCSharpBracketColorization === undefined;
      if (mergedKeys.length !== existingBackup.managedSemanticKeys.length || needsBracketBackupInit) {
        await this.setBackup({
          ...existingBackup,
          previousSemanticRules: nextPreviousRules,
          managedSemanticKeys: mergedKeys,
          hadCSharpBracketColorization:
            existingBackup.hadCSharpBracketColorization ?? csharpOverrides.hadBracket,
          previousCSharpBracketColorization:
            existingBackup.hadCSharpBracketColorization !== undefined
              ? existingBackup.previousCSharpBracketColorization
              : csharpOverrides.prevBracket,
          hadCSharpSemanticHighlighting:
            existingBackup.hadCSharpSemanticHighlighting ?? csharpOverrides.hadSemantic,
          previousCSharpSemanticHighlighting:
            existingBackup.hadCSharpSemanticHighlighting !== undefined
              ? existingBackup.previousCSharpSemanticHighlighting
              : csharpOverrides.prevSemantic,
        });
      }
    }

    await this.writeGlobalSemanticCustomizations({
      ...currentSemantic,
      enabled: true,
      rules: {
        ...currentSemanticRules,
        ...targetSemanticRules,
      },
    });

    await this.writeGlobalTokenCustomizations({
      ...currentToken,
      textMateRules: [...existingUserTextMateRules, ...targetTextMateRules],
    });

    await this.writeCSharpLanguageEditorOverrides(false, true);
  }

  private async removeOverlayIfApplied(): Promise<void> {
    const backup = this.getBackup();
    if (!backup) {
      return;
    }

    // 1. Restore semanticTokenColorCustomizations
    const currentSemantic = this.readGlobalSemanticCustomizations();
    const nextSemantic: SemanticTokenColorCustomizations = { ...currentSemantic };
    const nextSemanticRules: Record<string, unknown> = isPlainObject(currentSemantic.rules)
      ? { ...currentSemantic.rules }
      : {};

    for (const key of backup.managedSemanticKeys) {
      if (Object.prototype.hasOwnProperty.call(backup.previousSemanticRules, key)) {
        nextSemanticRules[key] = backup.previousSemanticRules[key];
      } else {
        delete nextSemanticRules[key];
      }
    }

    if (Object.keys(nextSemanticRules).length > 0) {
      nextSemantic.rules = nextSemanticRules;
    } else {
      delete nextSemantic.rules;
    }

    if (backup.hadSemanticEnabled) {
      nextSemantic.enabled = backup.previousSemanticEnabled;
    } else {
      delete nextSemantic.enabled;
    }

    // 2. Restore tokenColorCustomizations (strip only UnitySense-managed rules)
    const { value: currentToken } = this.readGlobalTokenCustomizations();
    const nextToken: TokenColorCustomizations = { ...currentToken };
    const remainingTextMateRules = (currentToken.textMateRules ?? []).filter(
      (r) => !isManagedTextMateRule(r),
    );
    if (remainingTextMateRules.length > 0 || backup.hadTextMateRules) {
      nextToken.textMateRules = remainingTextMateRules;
    } else {
      delete nextToken.textMateRules;
    }

    // 3. Restore [csharp] language-scoped bracket pair & semantic highlighting overrides
    const restoredBracket = backup.hadCSharpBracketColorization
      ? backup.previousCSharpBracketColorization
      : undefined;
    const restoredSemantic = backup.hadCSharpSemanticHighlighting
      ? backup.previousCSharpSemanticHighlighting
      : undefined;

    await this.setBackup(undefined);

    await this.writeGlobalSemanticCustomizations(
      Object.keys(nextSemantic).length > 0 ? nextSemantic : undefined,
    );
    await this.writeGlobalTokenCustomizations(
      Object.keys(nextToken).length > 0 ? nextToken : undefined,
    );
    await this.writeCSharpLanguageEditorOverrides(restoredBracket, restoredSemantic);
  }

  public dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}

export function registerToggleRiderHighlightingCommand(manager: RiderHighlightingManager): vscode.Disposable {
  return vscode.commands.registerCommand('unitySense.toggleRiderHighlighting', async () => {
    const enabled = await manager.toggle();
    void vscode.window.showInformationMessage(
      enabled
        ? '[UnitySense] JetBrains Rider Dark 코드 하이라이팅이 활성화되었습니다. (배경·UI 테마 유지)'
        : '[UnitySense] JetBrains Rider Dark 코드 하이라이팅이 비활성화되고 기존 설정으로 복원되었습니다.',
    );
    return enabled;
  });
}
