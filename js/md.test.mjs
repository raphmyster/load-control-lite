import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, esc } from './md.js';

test('headings drop one level to fit under the page title, bullets group into one list', () => {
  assert.equal(renderMarkdown('## Summary\n- one\n- two **big**'),
    '<h3>Summary</h3>\n<ul>\n<li>one</li>\n<li>two <strong>big</strong></li>\n</ul>');
});

test('paragraph lines join; a blank line ends a list', () => {
  assert.equal(renderMarkdown('- a\n\nplain\ntext'), '<ul>\n<li>a</li>\n</ul>\n<p>plain text</p>');
});

test('model output can never inject markup', () => {
  const html = renderMarkdown('## <img src=x onerror=alert(1)>\n- <script>alert(1)</script>\n**<b>x</b>**');
  assert.ok(!/<(img|script|b)\b/i.test(html), html);
  assert.match(html, /&lt;script&gt;/);
});

test('esc covers quotes for attribute use', () => {
  assert.equal(esc(`"a" & 'b'`), '&quot;a&quot; &amp; &#39;b&#39;');
});
