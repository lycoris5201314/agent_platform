import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentTray } from "../../app/components/AttachmentTray";

test("attachment tray renders an image preview before sending", () => {
  const path = "C:\\Pictures\\课堂照片.png";
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const html = renderToStaticMarkup(createElement(AttachmentTray, {
    files: [path],
    previews: { [path]: dataUrl },
    onRemove: () => undefined,
  }));

  assert.match(html, /class="attachment-preview-card image"/);
  assert.match(html, /data="data:image\/png;base64,iVBORw0KGgo="/);
  assert.match(html, /课堂照片\.png/);
  assert.match(html, /aria-label="移除 课堂照片\.png"/);
});

test("attachment tray keeps non-image files visible as file cards", () => {
  const path = "C:\\Documents\\资料.pdf";
  const html = renderToStaticMarkup(createElement(AttachmentTray, {
    files: [path],
    previews: {},
    onRemove: () => undefined,
  }));

  assert.match(html, /class="attachment-preview-card file"/);
  assert.match(html, />PDF</);
  assert.match(html, /资料\.pdf/);
});
