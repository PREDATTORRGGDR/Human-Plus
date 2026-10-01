import assert from 'node:assert/strict';
import { test } from 'node:test';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createSanitizer } from '../src/sanitize.js';

const sanitize = createSanitizer(createDOMPurify(new JSDOM('').window));

test('XSS-вектори прибираються', () => {
  const vectors = [
    '<script>alert(1)</script><p>ok</p>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
    '<p onclick="alert(1)">x</p>',
    '<svg onload=alert(1)><circle/></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '<style>body{display:none}</style>x',
    '<p style="background:url(javascript:alert(1))">x</p>',
    '<form action="https://evil.example"><input></form>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  ];
  for (const v of vectors) {
    const out = sanitize(v);
    assert.doesNotMatch(
      out,
      /<script|onerror|onclick|onload|javascript:|<iframe|<style|<form|<svg|<math|style=|data:/i,
      `${v} → ${out}`,
    );
  }
});

test('білий список тегів зберігається', () => {
  const html =
    '<h1>a</h1><h4>b</h4><p>x<br><b>b</b><i>i</i><u>u</u><strong>s</strong><em>e</em><code>c</code></p><ul><li>1</li></ul><ol><li>2</li></ol>';
  assert.equal(sanitize(html), html);
});

test('посилання: лише https, з rel=noopener, без target', () => {
  assert.match(sanitize('<a href="https://zoom.us/j/1">z</a>'), /href="https:\/\/zoom\.us\/j\/1"/);
  assert.match(
    sanitize('<a href="https://zoom.us/j/1" target="_blank">z</a>'),
    /rel="noopener noreferrer"/,
  );
  assert.doesNotMatch(sanitize('<a href="https://zoom.us/j/1" target="_blank">z</a>'), /target/);
  assert.doesNotMatch(sanitize('<a href="http://example.com">z</a>'), /href/);
  assert.doesNotMatch(sanitize('<a href="//example.com">z</a>'), /href/);
  assert.doesNotMatch(sanitize('<a href="ftp://example.com">z</a>'), /href/);
});

test('null, undefined і не-рядки не падають', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(sanitize(42), '42');
});
