import test from 'node:test';
import assert from 'node:assert/strict';
import { checkJavascriptSyntax, extractFileList } from '../apps/worker/services/codeChecks.js';

const file = (name, source, language = 'js') =>
  '### Archivo: ' + name + '\n```' + language + '\n' + source + '\n```';

test('comprueba imports relativos cuando los módulos están en la entrega', async () => {
  const delivery = [
    file('calc-overlay.js', "import { calculate } from './calc-engine.js';\nexport const run = calculate;"),
    file('calc-engine.js', 'export function calculate(value) { return value; }')
  ].join('\n\n');
  const result = await checkJavascriptSyntax(delivery);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.filesChecked, 2);
});

test('rechaza imports relativos que apuntan a archivos ausentes', async () => {
  const delivery = file('calc-overlay.js', "import { calculate } from './calc-engine.js';\nexport const run = calculate;");
  const result = await checkJavascriptSyntax(delivery);
  assert.equal(result.ok, false);
  assert.match(result.message, /calc-engine\.js/);
});

test('rechaza rutas de archivo duplicadas en una entrega', async () => {
  const delivery = [
    file('calc.js', 'export const first = true;'),
    file('calc.js', 'export const second = true;')
  ].join('\n\n');
  const result = await checkJavascriptSyntax(delivery);
  assert.equal(result.ok, false);
  assert.match(result.message, /aparece más de una vez/);
});


test('no ejecuta HTML generado dentro del Worker y declara que la prueba de navegador requiere runner aislado', async () => {
  const delivery = file('index.html', '<!doctype html><html><head></head><body><script>throw new Error("must not execute in worker")</script></body></html>', 'html');
  const result = await checkJavascriptSyntax(delivery);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.browserChecked, false);
  assert.match(result.message, /NO EJECUTADA dentro del Worker/);
});

test('adapta el Map de extractFiles al arreglo de archivos requerido por los workspaces', () => {
  const delivery = [
    file('index.html', '<main>Hola</main>', 'html'),
    file('src/app.js', 'export const answer = 42;')
  ].join('\\n\\n');
  assert.deepEqual(extractFileList(delivery), [
    { path: 'index.html', content: '<main>Hola</main>' },
    { path: 'src/app.js', content: 'export const answer = 42;' }
  ]);
});
