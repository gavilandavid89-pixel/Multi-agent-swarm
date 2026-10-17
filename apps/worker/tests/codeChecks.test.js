import test from 'node:test';
import assert from 'node:assert/strict';
import { checkJavascriptSyntax } from '../services/codeChecks.js';

const deliver = (...blocks) => blocks.join('\n\n');

test('code checks reject invalid JavaScript syntax in a named file', async () => {
  const result = await checkJavascriptSyntax(deliver(
    '### Archivo: src/app.js',
    '```javascript\nfunction broken( {\n```'
  ));
  assert.equal(result.ok, false);
  assert.match(result.message, /src\/app\.js/);
});

test('code checks reject malformed package.json', async () => {
  const result = await checkJavascriptSyntax(deliver(
    '### Archivo: package.json',
    '```json\n{"scripts": }\n```'
  ));
  assert.equal(result.ok, false);
  assert.match(result.message, /package\.json: JSON inválido/);
});

test('code checks detect a missing relative JavaScript import', async () => {
  const result = await checkJavascriptSyntax(deliver(
    '### Archivo: src/app.js',
    '```javascript\nimport { boot } from "./missing.js";\n```'
  ));
  assert.equal(result.ok, false);
  assert.match(result.message, /importa \.\/missing\.js/);
});

test('code checks accept valid JavaScript with a present relative import', async () => {
  const result = await checkJavascriptSyntax(deliver(
    '### Archivo: src/app.js',
    '```javascript\nimport { boot } from "./boot.js";\nboot();\n```',
    '### Archivo: src/boot.js',
    '```javascript\nexport const boot = () => true;\n```'
  ));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.javascriptChecked, 2);
});

test('code checks report when a delivery has no machine-checkable files', async () => {
  const result = await checkJavascriptSyntax('La propuesta explica la idea, pero no incluye archivos.');
  assert.equal(result.ok, true);
  assert.equal(result.checked, false);
  assert.match(result.message, /solo recibió revisión de IA/);
});
