import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import type {
  UnityApiDatabase,
  UnityApiParameter,
  UnityApiTypeEntry,
  UnityEventFunction,
} from '../../../packages/extension/src/contracts/index.ts';

const PERFORMANCE_CRITICAL_EVENTS = new Set([
  'Update',
  'FixedUpdate',
  'LateUpdate',
  'OnGUI',
  'OnAnimatorIK',
  'OnAnimatorMove',
  'OnRenderObject',
  'OnPostRender',
  'OnPreRender',
]);

const COROUTINE_SUPPORTED_EVENTS = new Set([
  'Start',
  'OnTriggerEnter',
  'OnTriggerStay',
  'OnTriggerExit',
  'OnTriggerEnter2D',
  'OnTriggerStay2D',
  'OnTriggerExit2D',
  'OnCollisionEnter',
  'OnCollisionStay',
  'OnCollisionExit',
  'OnCollisionEnter2D',
  'OnCollisionStay2D',
  'OnCollisionExit2D',
  'OnMouseDown',
  'OnMouseUp',
  'OnMouseDrag',
  'OnMouseEnter',
  'OnMouseExit',
  'OnMouseOver',
  'OnMouseUpAsButton',
  'OnBecameVisible',
  'OnBecameInvisible',
  'OnParticleCollision',
  'OnParticleTrigger',
]);

interface RawXmlParam {
  '@_name'?: string;
  '@_type'?: string;
  '@_optional'?: string;
  '@_description'?: string;
  '#text'?: string;
}

interface RawXmlMessage {
  '@_name'?: string;
  '@_static'?: string;
  '@_coroutine'?: string;
  '@_minimumVersion'?: string;
  '@_maximumVersion'?: string;
  '@_returnType'?: string;
  summary?: string | { '#text'?: string };
  docstring?: string | { '#text'?: string };
  returns?: { '@_type'?: string };
  parameters?: {
    parameter?: RawXmlParam | RawXmlParam[];
    param?: RawXmlParam | RawXmlParam[];
  };
}

interface RawXmlType {
  '@_name'?: string;
  '@_ns'?: string;
  '@_kind'?: string;
  '@_minimumVersion'?: string;
  message?: RawXmlMessage | RawXmlMessage[];
}

interface RawXmlApiRoot {
  api?: {
    '@_minimumVersion'?: string;
    type?: RawXmlType | RawXmlType[];
  };
}

function asArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function extractText(val: string | { '#text'?: string } | undefined): string {
  if (typeof val === 'string') return val.trim();
  if (val && typeof val === 'object' && typeof val['#text'] === 'string') {
    return val['#text'].trim();
  }
  return '';
}

export function extractUnityApiXmlToJson(
  xmlContent: string,
  sourceCommit?: string,
): UnityApiDatabase {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: true,
    isArray: (tagName) =>
      tagName === 'type' ||
      tagName === 'message' ||
      tagName === 'parameter' ||
      tagName === 'param',
  });

  const parsed = parser.parse(xmlContent) as RawXmlApiRoot;
  const rawTypes = asArray(parsed.api?.type);

  const typeMap = new Map<string, UnityApiTypeEntry>();
  for (const rawType of rawTypes) {
    if (!rawType['@_name']) continue;
    const name = String(rawType['@_name']);
    const ns = rawType['@_ns'] ? String(rawType['@_ns']) : '';
    const fullName = ns ? `${ns}.${name}` : name;
    const kind: 'class' | 'struct' = rawType['@_kind'] === 'struct' ? 'struct' : 'class';

    const events: UnityEventFunction[] = asArray(rawType.message)
      .filter((m) => Boolean(m['@_name']))
      .map((msg) => {
        const eventName = String(msg['@_name']);
        const returnType = msg.returns?.['@_type']
          ? String(msg.returns['@_type'])
          : msg['@_returnType']
          ? String(msg['@_returnType'])
          : 'void';
        const supportsCoroutine =
          msg['@_coroutine'] === 'true' || COROUTINE_SUPPORTED_EVENTS.has(eventName);
        const isStatic = msg['@_static'] === 'true';
        const isPerformanceCritical = PERFORMANCE_CRITICAL_EVENTS.has(eventName);
        const description = extractText(msg.summary) || extractText(msg.docstring) || `${eventName} Unity message.`;

        const rawParams = [
          ...asArray(msg.parameters?.parameter),
          ...asArray(msg.parameters?.param),
        ];
        const parameters: UnityApiParameter[] = rawParams
          .filter((p) => Boolean(p['@_name'] && p['@_type']))
          .map((p) => {
            const entry: UnityApiParameter = {
              name: String(p['@_name']),
              type: String(p['@_type']),
            };
            if (p['@_optional'] === 'true') {
              entry.isOptional = true;
            }
            const pDesc = p['@_description'] ? String(p['@_description']) : p['#text'];
            if (pDesc) {
              entry.description = String(pDesc).trim();
            }
            return entry;
          });

        const fn: UnityEventFunction = {
          name: eventName,
          returnType,
          supportsCoroutine,
          description,
          parameters,
        };
        if (isStatic) fn.isStatic = true;
        if (isPerformanceCritical) fn.isPerformanceCritical = true;
        if (msg['@_minimumVersion']) fn.minimumUnityVersion = String(msg['@_minimumVersion']);
        if (msg['@_maximumVersion']) fn.maximumUnityVersion = String(msg['@_maximumVersion']);
        return fn;
      });

    const existing = typeMap.get(fullName);
    if (existing) {
      const seenEvents = new Set(existing.events.map((e) => e.name));
      for (const ev of events) {
        if (!seenEvents.has(ev.name)) {
          seenEvents.add(ev.name);
          existing.events.push(ev);
        }
      }
      if (!existing.minimumUnityVersion && rawType['@_minimumVersion']) {
        existing.minimumUnityVersion = String(rawType['@_minimumVersion']);
      }
    } else {
      const seenEvents = new Set<string>();
      const dedupedEvents: UnityEventFunction[] = [];
      for (const ev of events) {
        if (!seenEvents.has(ev.name)) {
          seenEvents.add(ev.name);
          dedupedEvents.push(ev);
        }
      }
      const entry: UnityApiTypeEntry = {
        fullName,
        kind,
        events: dedupedEvents,
      };
      if (rawType['@_minimumVersion']) {
        entry.minimumUnityVersion = String(rawType['@_minimumVersion']);
      }
      typeMap.set(fullName, entry);
    }
  }
  const types: UnityApiTypeEntry[] = Array.from(typeMap.values());

  const db: UnityApiDatabase = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    types,
  };
  if (sourceCommit) {
    db.sourceCommit = sourceCommit;
  }
  return db;
}

function parseCliArgs(argv: string[]): { input: string; output: string; commit?: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..');
  let input = path.join(repoRoot, 'tools', 'api-extractor', 'test', 'fixtures', 'sample-api.xml');
  let output = path.join(repoRoot, 'packages', 'extension', 'resources', 'unity-api.json');
  let commit: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      input = path.resolve(argv[++i]);
    } else if (arg === '--output' && argv[i + 1]) {
      output = path.resolve(argv[++i]);
    } else if (arg === '--commit' && argv[i + 1]) {
      commit = argv[++i];
    }
  }
  return { input, output, commit };
}

const resolvedArgv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
const resolvedSelf = path.resolve(fileURLToPath(import.meta.url));
const isEntrypoint = Boolean(
  resolvedArgv1 &&
    (process.platform === 'win32'
      ? resolvedArgv1.toLowerCase() === resolvedSelf.toLowerCase()
      : resolvedArgv1 === resolvedSelf),
);

if (isEntrypoint) {
  const { input, output, commit } = parseCliArgs(process.argv.slice(2));
  const xml = fs.readFileSync(input, 'utf8');
  const db = extractUnityApiXmlToJson(xml, commit ?? 'resharper-unity-snapshot');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(db, null, 2), 'utf8');
  console.log(`Generated ${output} (${db.types.length} types).`);
}
