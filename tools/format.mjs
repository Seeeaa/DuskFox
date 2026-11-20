import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const check = process.argv.includes('--check');
const targets = process.argv.slice(2).filter(arg => arg !== '--check');
const files = [];
function collect(target) {
  const info = fs.statSync(target);
  if (info.isDirectory()) {
    for (const name of fs.readdirSync(target)) collect(path.join(target, name));
  } else if (/\.(?:ts|mjs|cjs)$/.test(target)) files.push(path.resolve(target));
}
for (const target of targets.length ? targets : ['src', 'runtime', 'tests', 'tools']) collect(target);

const settings = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: '\n',
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterSemicolonInForStatements: true,
  insertSpaceBeforeAndAfterBinaryOperators: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true,
  insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
  semicolons: ts.SemicolonPreference.Ignore,
};
let changed = 0;
for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  const host = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => '0',
    getScriptSnapshot: name => name === file ? ts.ScriptSnapshot.fromString(original) : undefined,
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => ({ allowJs: true }),
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: fs.existsSync,
    readFile: name => fs.readFileSync(name, 'utf8'),
  };
  const service = ts.createLanguageService(host);
  const edits = service.getFormattingEditsForDocument(file, settings);
  let output = original;
  for (const edit of edits.sort((a, b) => b.span.start - a.span.start)) {
    output = output.slice(0, edit.span.start) + edit.newText + output.slice(edit.span.start + edit.span.length);
  }
  service.dispose();
  output = output.replace(/\r\n/g, '\n').replace(/[\t ]+$/gm, '').trimEnd() + '\n';
  if (output === original) continue;
  changed += 1;
  if (check) process.stderr.write(path.relative(process.cwd(), file) + '\n');
  else fs.writeFileSync(file, output, 'utf8');
}
if (check) process.exitCode = changed ? 1 : 0;
else process.stdout.write(`Formatted ${changed} files.\n`);
