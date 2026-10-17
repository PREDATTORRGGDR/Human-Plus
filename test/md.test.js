import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../src/md.js';

const doc = new JSDOM('').window.document;
const html = (md) => {
  const div = doc.createElement('div');
  div.append(renderMarkdown(md, doc));
  return div.innerHTML;
};

test('відповідь моделі: розмітка списків, жирного, коду; HTML з відповіді не інтерпретується', () => {
  assert.equal(html('**Крок 1**: *увага*'), '<p><strong>Крок 1</strong>: <em>увага</em></p>');
  assert.equal(html('1. а\n2. б'), '<ol><li>а</li><li>б</li></ol>');
  assert.equal(html('- x\n- y\n\nтекст'), '<ul><li>x</li><li>y</li></ul><p>текст</p>');
  assert.equal(html('```\na<b\n```'), '<pre class="md-code"><code>a&lt;b</code></pre>');
  const evil = html('<img src=x onerror=alert(1)><script>alert(2)</script> **<b>x</b>**');
  assert.ok(!/<img|<script|<b>/.test(evil));
  assert.match(evil, /&lt;img/);
});
