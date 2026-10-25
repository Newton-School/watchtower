import type { Node, SourceFile } from 'typescript';
import type { ContentPolicy } from '../repos/registry.js';

/**
 * Whether a pull request only changes content: copy, numbers and asset links
 * on pages (issue #701). Such a PR may be merged on the word of anyone who
 * could have asked for the change, so the check errs towards "no": a file it
 * cannot read, parse or place is not content.
 *
 * A file passes when its old and new versions are the same program once the
 * literals in content positions are masked out: page text, values in data
 * objects and arrays, and copy attributes like `alt` or `href`. A literal
 * compared, passed to a call or used as a key stays as it is, so changing it
 * is a change of behaviour.
 */
export type ContentOnlyVerdict =
  /** `headSha` is the commit that was read: a merge must be of that commit and no later one. */
  | { contentOnly: true; files: string[]; headSha: string }
  | {
      contentOnly: false;
      /** For the logs. */
      reason: string;
      /** What kept it from counting: a file outside content, too many files, or a diff that could not be read. */
      kind: 'not_content' | 'too_many_files' | 'unreadable';
      /** The files that are more than content, when known. */
      offending?: string[];
      /** How many files the PR changes, when known. */
      fileCount?: number;
    };

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** More files than this is more than a copy edit, whatever they contain. */
export const CONTENT_ONLY_MAX_FILES = 20;
const MAX_FILE_BYTES = 200_000;

/** `**` spans any number of folders (none included), `*` stays within one. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        pattern += '(?:.*/)?';
        i += 2;
      } else {
        pattern += '.*';
        i += 1;
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** Whether a path is a TypeScript file a content-only change may touch. */
export function isContentPath(filePath: string, policy: ContentPolicy): boolean {
  if (!/\.tsx?$/.test(filePath) || filePath.endsWith('.d.ts')) return false;
  const matches = (globs: string[]) => globs.some(glob => globToRegExp(glob).test(filePath));
  return matches(policy.allow) && !matches(policy.deny);
}

type Ts = typeof import('typescript');
let tsModule: Promise<Ts> | undefined;
/** Loaded on first use: the compiler is large and only a merge needs it. */
function loadTypescript(): Promise<Ts> {
  tsModule ??= import('typescript').then(module => module.default);
  return tsModule;
}

/**
 * Attributes and keys whose literal values set behaviour or styling, not
 * words on the page: changing one is not a content change.
 */
const NON_COPY_NAMES = new Set([
  'className',
  'class',
  'style',
  'id',
  'key',
  'ref',
  'type',
  'name',
  'htmlFor',
  'target',
  'rel',
  'role',
  'variant',
  'size',
  'color',
  'theme',
  'as',
  'method',
  'action',
  'loading',
  'priority',
  'strategy',
  'sizes',
  'fill',
  'layout',
  'objectFit',
  'objectPosition',
  'tabIndex',
  'dangerouslySetInnerHTML',
  '__html',
]);

/** Ids, keys, tracking events, experiment arms and endpoints, in any casing: `formId`, `FORM_ID`, `eventKey`. */
const NON_COPY_SUFFIX_SNAKE = /(?:^|_)(?:id|key|event|arm|variant|endpoint|api)$/i;
const NON_COPY_SUFFIX_CAMEL = /[a-z0-9](?:Id|ID|Key|Event|Arm|Variant|Endpoint|Api|API)$/;

function isCopyName(name: string | undefined): boolean {
  if (!name) return false;
  if (NON_COPY_NAMES.has(name) || name.startsWith('data-')) return false;
  return !NON_COPY_SUFFIX_SNAKE.test(name) && !NON_COPY_SUFFIX_CAMEL.test(name);
}

/** Elements whose text and attributes are code or load code: never content. */
const CODE_ELEMENTS = new Set(['script', 'Script', 'style', 'iframe', 'link', 'object', 'embed', 'base']);

/** A link that runs or embeds something rather than going somewhere. */
const ACTIVE_URL = /^\s*(?:javascript|data|vbscript):/i;

function tagNameOf(ts: Ts, element: Node | undefined): string | undefined {
  if (!element) return undefined;
  if (ts.isJsxElement(element)) return element.openingElement.tagName.getText();
  if (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) return element.tagName.getText();
  return undefined;
}

/** The attribute's element is not one whose attributes are code. */
function onCopyElement(ts: Ts, attribute: Node): boolean {
  const tag = tagNameOf(ts, attribute.parent?.parent);
  return tag === undefined || !CODE_ELEMENTS.has(tag);
}

function nameText(ts: Ts, name: Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

/**
 * Whether a literal sits where its value is content: text in JSX, a copy
 * attribute, or a value in a data structure that is assigned, exported,
 * returned or passed as a JSX prop. Never a call argument, a comparison, a
 * key or a condition.
 */
function isContentPosition(ts: Ts, node: Node): boolean {
  let child: Node = node;
  let parent: Node | undefined = node.parent;
  while (parent) {
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      if (parent.expression !== child) return false;
    } else if (ts.isConditionalExpression(parent)) {
      if (parent.condition === child) return false;
    } else if (ts.isArrayLiteralExpression(parent)) {
      // An element: keep going up to whatever holds the array.
    } else if (ts.isPropertyAssignment(parent)) {
      if (parent.initializer !== child || !isCopyName(nameText(ts, parent.name))) return false;
      // Up to the object literal holding this property.
      parent = parent.parent;
    } else if (ts.isJsxAttribute(parent)) {
      return parent.initializer === child && isCopyName(nameText(ts, parent.name)) && onCopyElement(ts, parent);
    } else if (ts.isJsxExpression(parent)) {
      const holder = parent.parent;
      if (ts.isJsxAttribute(holder)) return isCopyName(nameText(ts, holder.name)) && onCopyElement(ts, holder);
      if (ts.isJsxFragment(holder)) return true;
      return ts.isJsxElement(holder) && !CODE_ELEMENTS.has(tagNameOf(ts, holder) ?? '');
    } else if (ts.isVariableDeclaration(parent)) {
      return parent.initializer === child && isCopyName(nameText(ts, parent.name));
    } else if (ts.isExportAssignment(parent) || ts.isReturnStatement(parent)) {
      return true;
    } else if (ts.isArrowFunction(parent)) {
      return parent.body === child;
    } else {
      return false;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function isSignedNumber(ts: Ts, node: Node): boolean {
  return (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    (ts.isNumericLiteral(node.operand) || ts.isBigIntLiteral(node.operand))
  );
}

/**
 * The file as a list of tokens with comments and whitespace dropped and
 * content literals replaced by their kind, or undefined when it does not
 * parse.
 */
export async function contentMaskedTokens(source: string, fileName: string): Promise<string[] | undefined> {
  const ts = await loadTypescript();
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file: SourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  // Not in the public typings, but set on every parsed file.
  const diagnostics = (file as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return undefined;

  const tokens: string[] = [];
  const visit = (node: Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isJsxText(node)) {
      if (node.containsOnlyTriviaWhiteSpaces) return;
      // The body of a <script> or <style> is code, compared as written.
      const code = CODE_ELEMENTS.has(tagNameOf(ts, node.parent) ?? '');
      tokens.push(code ? node.text.replace(/\s+/g, ' ').trim() : '<text>');
      return;
    }
    // What a formatter adds when a longer text no longer fits on one line:
    // parentheses around JSX and `{' '}` between words and tags.
    if (ts.isParenthesizedExpression(node) && isJsxNode(ts, node.expression)) {
      visit(node.expression);
      return;
    }
    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      node.expression &&
      (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
      node.expression.text.trim() === ''
    ) {
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!ACTIVE_URL.test(node.text) && isContentPosition(ts, node)) {
        tokens.push('<string>');
        return;
      }
    } else if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      // A signed number is masked whole, as the unary expression.
      if (!isSignedNumber(ts, node.parent) && isContentPosition(ts, node)) {
        tokens.push('<number>');
        return;
      }
    } else if (isSignedNumber(ts, node)) {
      if (isContentPosition(ts, node)) {
        tokens.push('<number>');
        return;
      }
    } else if (ts.isTemplateExpression(node) && isContentPosition(ts, node)) {
      // The text around each `${}` is content; the expressions are not.
      tokens.push('<template>');
      for (const span of node.templateSpans) {
        tokens.push('${');
        visit(span.expression);
        tokens.push('}');
      }
      tokens.push('</template>');
      return;
    }
    const children = node.getChildren(file);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node.getText(file));
      return;
    }
    for (const childNode of children) visit(childNode);
  };
  visit(file);
  // A trailing comma, which a formatter adds when a list breaks over lines, changes nothing.
  return tokens.filter((token, index) => token !== ',' || !CLOSERS.has(tokens[index + 1] ?? ''));
}

const CLOSERS = new Set(['}', ']', ')', '>']);

function isJsxNode(ts: Ts, node: Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

/** Whether two versions of a file differ only in content literals; undefined when either does not parse. */
export async function differsOnlyInContent(base: string, head: string, fileName: string): Promise<boolean | undefined> {
  const [before, after] = await Promise.all([contentMaskedTokens(base, fileName), contentMaskedTokens(head, fileName)]);
  if (!before || !after) return undefined;
  return before.length === after.length && before.every((token, index) => token === after[index]);
}

function encodePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

/** Reads whether a pull request is content-only under a repo's policy. Never throws. */
export async function checkContentOnlyPr(params: {
  owner: string;
  repo: string;
  number: number;
  githubToken: string;
  policy: ContentPolicy;
  fetcher?: Fetcher;
}): Promise<ContentOnlyVerdict> {
  const { owner, repo, number, githubToken, policy } = params;
  const fetcher = params.fetcher ?? fetch;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const get = (url: string, accept = 'application/vnd.github+json') =>
    fetcher(url, {
      headers: { Accept: accept, Authorization: `Bearer ${githubToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  const unreadable = (reason: string, fileCount?: number): ContentOnlyVerdict => ({
    contentOnly: false,
    kind: 'unreadable',
    reason,
    ...(fileCount !== undefined ? { fileCount } : {}),
  });

  try {
    const prResponse = await get(`${api}/pulls/${number}`);
    if (!prResponse.ok) return unreadable(`GitHub answered ${prResponse.status} for the pull request.`);
    const pr = (await prResponse.json()) as { state?: string; head?: { sha?: string }; base?: { sha?: string } };
    const headSha = pr.head?.sha;
    const baseSha = pr.base?.sha;
    if (pr.state !== 'open' || !headSha || !baseSha) return unreadable('The pull request is not open.');

    // One page is enough: anything past the limit is not content-only anyway.
    const filesResponse = await get(`${api}/pulls/${number}/files?per_page=100`);
    if (!filesResponse.ok) return unreadable(`GitHub answered ${filesResponse.status} for the changed files.`);
    const files = (await filesResponse.json()) as Array<{ filename?: string; status?: string }>;
    if (!Array.isArray(files) || files.length === 0) return unreadable('GitHub listed no changed files.');
    if (files.length > CONTENT_ONLY_MAX_FILES) {
      return {
        contentOnly: false,
        kind: 'too_many_files',
        reason: `It changes ${files.length >= 100 ? '100 or more' : files.length} files.`,
        fileCount: files.length,
      };
    }

    const misplaced = files
      .filter(file => !file.filename || file.status !== 'modified' || !isContentPath(file.filename, policy))
      .map(file => file.filename ?? '(unnamed file)');
    if (misplaced.length > 0) {
      return {
        contentOnly: false,
        kind: 'not_content',
        reason: 'It adds, removes or renames files, or changes files outside content.',
        offending: misplaced,
        fileCount: files.length,
      };
    }

    // The change is the head against where the branch left its base, the diff GitHub shows.
    const compareResponse = await get(`${api}/compare/${baseSha}...${headSha}`);
    if (!compareResponse.ok) return unreadable(`GitHub answered ${compareResponse.status} for the merge base.`);
    const mergeBase = ((await compareResponse.json()) as { merge_base_commit?: { sha?: string } }).merge_base_commit
      ?.sha;
    if (!mergeBase) return unreadable('GitHub gave no merge base.', files.length);

    const readAt = async (filePath: string, ref: string): Promise<string | undefined> => {
      const response = await get(
        `${api}/contents/${encodePath(filePath)}?ref=${ref}`,
        'application/vnd.github.raw+json',
      );
      if (!response.ok) return undefined;
      const text = await response.text();
      return Buffer.byteLength(text) > MAX_FILE_BYTES ? undefined : text;
    };

    const changed: string[] = [];
    const names = files.map(file => file.filename as string);
    for (const filePath of names) {
      const [before, after] = await Promise.all([readAt(filePath, mergeBase), readAt(filePath, headSha)]);
      if (before === undefined || after === undefined) {
        return unreadable(`Couldn't read ${filePath} (missing, unreadable or too large).`, files.length);
      }
      const same = await differsOnlyInContent(before, after, filePath);
      if (same === undefined) return unreadable(`Couldn't parse ${filePath}.`, files.length);
      if (!same) changed.push(filePath);
    }
    if (changed.length > 0) {
      return {
        contentOnly: false,
        kind: 'not_content',
        reason: 'It changes code, not only text, numbers or links.',
        offending: changed,
        fileCount: files.length,
      };
    }
    return { contentOnly: true, files: names, headSha };
  } catch (error) {
    return unreadable(`Couldn't read the diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}
