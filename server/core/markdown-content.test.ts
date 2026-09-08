import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../../app/components/MarkdownContent.tsx";

test("renders useful Markdown while refusing raw HTML", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: "# 结果\n\n**重点**和`代码`\n\n- 第一项\n- 第二项\n\n| 名称 | 状态 |\n| --- | --- |\n| 测试 | 通过 |\n\n```ts\nconst ok = true;\n```\n\n<script>alert('no')</script>",
  }));

  assert.match(html, /<h1>结果<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /class="markdown-table"/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\(&#x27;no&#x27;\)/);
});
