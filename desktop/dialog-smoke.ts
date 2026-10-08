import type { BrowserWindow } from "electron";
import fs from "node:fs";

// Send input through Chromium hit testing; dispatchEvent can bypass a blocked handle.
export async function dragDialogWithMouse(window: BrowserWindow, selector: string): Promise<void> {
  const before = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector(${JSON.stringify(selector)});
    const rect = dialog?.getBoundingClientRect();
    const handle = dialog?.querySelector('.dialog-drag-handle')?.getBoundingClientRect();
    if (!rect || !handle) throw new Error('Missing dialog or drag handle');
    return { left: rect.left, top: rect.top, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 8) };
  })()`) as { left: number; top: number; x: number; y: number };
  window.focus();
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "mouseMove", x: before.x, y: before.y });
  window.webContents.sendInputEvent({ type: "mouseDown", x: before.x, y: before.y, button: "left", clickCount: 1 });
  for (let step = 1; step <= 6; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.webContents.sendInputEvent({ type: "mouseMove", x: before.x + step * 12, y: before.y + step * 6, modifiers: ["leftbuttondown"] });
  }
  window.webContents.sendInputEvent({ type: "mouseUp", x: before.x + 72, y: before.y + 36, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, visible: rect.left >= 7 && rect.top >= 7 && rect.right <= innerWidth - 7 && rect.bottom <= innerHeight - 7 } : null;
  })()`) as { left: number; top: number; visible: boolean } | null;
  if (!after || after.left - before.left < 60 || after.top - before.top < 28 || !after.visible) {
    throw new Error(`Native dialog drag failed: ${JSON.stringify({ selector, before, after })}`);
  }
  console.log(`Native dialog drag passed: ${selector}`);
}

export async function verifyImageAndPrompt(window: BrowserWindow, imagePath: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('.thread-row')].find((row) => row.textContent.includes('窗口验收 B'))?.click();
    for (let i = 0; i < 100 && ![...document.querySelectorAll('.turn-change-card button')].some((b) => b.textContent.includes('review-fixture.txt')); i++) await new Promise(r => setTimeout(r, 50));
    const file = [...document.querySelectorAll('.turn-change-card button')].find((b) => b.textContent.includes('review-fixture.txt'));
    if (!file) throw new Error('Missing review fixture');
    file.click();
    for (let i = 0; i < 80 && !document.querySelector('.code-preview.diff > span'); i++) await new Promise(r => setTimeout(r, 50));
    document.querySelector('.code-preview.diff > span')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector('.prompt-dialog'); i++) await new Promise(r => setTimeout(r, 50));
  })()`);
  await dragDialogWithMouse(window, ".prompt-dialog");
  await window.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('.prompt-dialog textarea');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '拖动后仍可输入');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    if (input.value !== '拖动后仍可输入') throw new Error('Prompt input failed after drag');
    document.querySelector('.prompt-dialog footer button').click();
    document.querySelector('.preview-header > button').click();
    await new Promise(r => setTimeout(r, 50));
    [...document.querySelectorAll('.file-row')].find(b => b.textContent.includes('preview-fixture.png'))?.click();
    for (let i = 0; i < 80 && !document.querySelector('.image-preview img')?.naturalWidth; i++) await new Promise(r => setTimeout(r, 50));
    if (document.querySelector('.image-preview img')?.naturalWidth !== 1) throw new Error('Sidebar image did not decode');
    document.querySelector('.new-task-button').click();
    for (let i = 0; i < 80 && !document.querySelector('.draft-message-composer'); i++) await new Promise(r => setTimeout(r, 50));
  })()`);
  const point = await window.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('.draft-message-composer textarea').getBoundingClientRect();
    return { x: r.left + 30, y: r.top + 20 };
  })()`) as { x: number; y: number };
  window.webContents.debugger.attach("1.3");
  try {
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await window.webContents.debugger.sendCommand("Input.dispatchDragEvent", { type, ...point, data: { items: [], files: [imagePath], dragOperationsMask: 1 } });
    }
  } finally { window.webContents.debugger.detach(); }
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100 && !document.querySelector('.attachment-preview-card img')?.naturalWidth; i++) await new Promise(r => setTimeout(r, 50));
    const img = document.querySelector('.attachment-preview-card img');
    if (!img?.complete || img.naturalWidth !== 1 || document.querySelector('.attachment-preview-card object')) throw new Error('Dropped image did not decode');
  })()`);
  await verifyComposerDrag(window, true);
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('.attachment-preview-card button').click();
    await new Promise(r => setTimeout(r, 50));
    if (document.querySelector('.attachment-preview-card')) throw new Error('Attachment removal failed');
    [...document.querySelectorAll('.draft-conversation-header button')].find(b => b.textContent.includes('丢弃草稿')).click();
  })()`);
  await verifyComposerDrag(window, false);
  console.log("Native image file drop and sidebar preview decoded successfully; prompt remains editable after dragging");
}

async function verifyComposerDrag(window: BrowserWindow, draft: boolean): Promise<void> {
  const selector = draft ? ".draft-composer-dock" : ".composer-dock:not(.draft-composer-dock)";
  const before = await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 80 && !document.querySelector(${JSON.stringify(selector)}); i++) await new Promise(r => setTimeout(r, 50));
    const dock = document.querySelector(${JSON.stringify(selector)});
    const input = dock.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '输入框拖动验收');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const r = dock.querySelector('.composer-movable').getBoundingClientRect();
    const h = dock.querySelector('.composer-drag-handle').getBoundingClientRect();
    return { left: r.left, top: r.top, x: Math.round(h.left + h.width / 2), y: Math.round(h.top + h.height / 2) };
  })()`) as { left: number; top: number; x: number; y: number };
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await new Promise(r => setTimeout(r, 25));
      window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x + dx * i / 6), y: Math.round(y + dy * i / 6), modifiers: ["leftbuttondown"] });
    }
    window.webContents.sendInputEvent({ type: "mouseUp", x: x + dx, y: y + dy, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
  };
  await drag(before.x, before.y, 16, -90);
  const moved = await window.webContents.executeJavaScript(`(() => {
    const d = document.querySelector(${JSON.stringify(selector)});
    const r = d.querySelector('.composer-movable').getBoundingClientRect();
    const button = d.querySelector('.send-button');
    const b = button.getBoundingClientRect();
    return { top: r.top, text: d.querySelector('textarea').value, hit: document.elementFromPoint(b.left + b.width/2, b.top + b.height/2) === button, image: ${draft} ? d.querySelector('img')?.naturalWidth : 1 };
  })()`) as { top: number; text: string; hit: boolean; image: number };
  if (before.top - moved.top < 70 || moved.text !== "输入框拖动验收" || !moved.hit || !moved.image) throw new Error(`Composer drag/content failed: ${JSON.stringify({ before, moved, draft })}`);
  // A window resize must not strand the composer or its Send button off-screen.
  const savedBounds = window.getBounds();
  window.setSize(1080, 700);
  await new Promise(r => setTimeout(r, 200));
  const visible = await window.webContents.executeJavaScript(`(() => {
    const d = document.querySelector(${JSON.stringify(selector)});
    const r = d.querySelector('.composer-movable').getBoundingClientRect();
    const p = d.closest('.conversation-pane').getBoundingClientRect();
    const b = d.querySelector('.send-button').getBoundingClientRect();
    return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom && b.bottom <= innerHeight;
  })()`);
  if (!visible) throw new Error("Composer escaped conversation bounds after resize");
  window.setBounds(savedBounds);
  await new Promise(r => setTimeout(r, 150));
  const reset = await window.webContents.executeJavaScript(`(async () => {
    const d = document.querySelector(${JSON.stringify(selector)});
    d.querySelector('.composer-reset-position').click();
    await new Promise(r => setTimeout(r, 100));
    const r = d.querySelector('.composer-movable').getBoundingClientRect();
    return { left: r.left, top: r.top, disabled: d.querySelector('.composer-reset-position').disabled };
  })()`) as { left: number; top: number; disabled: boolean };
  if (!reset.disabled || Math.abs(reset.left - before.left) > 2 || Math.abs(reset.top - before.top) > 2) throw new Error(`Composer reset failed: ${JSON.stringify({ before, reset })}`);
  if (!draft) {
    await drag(before.x, before.y, 16, -90);
    if (process.env.AGENT_COMPOSER_SCREENSHOT) fs.writeFileSync(process.env.AGENT_COMPOSER_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    const send = await window.webContents.executeJavaScript(`(() => {
      const b = document.querySelector(${JSON.stringify(selector)}).querySelector('.send-button');
      if (b.disabled) throw new Error('Composer send disabled');
      const r = b.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
    })()`) as { x: number; y: number };
    window.webContents.sendInputEvent({ type: "mouseDown", ...send, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...send, button: "left", clickCount: 1 });
    await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 160 && (document.querySelector('.composer-dock textarea')?.value || !document.querySelector('.header-meta')?.textContent?.includes('已完成')); i++) await new Promise(r => setTimeout(r, 50));
      if (document.querySelector('.composer-dock textarea')?.value) throw new Error('Dragged composer message was not sent');
      document.querySelector('.composer-reset-position').click();
    })()`);
  }
  console.log(`Composer mouse drag, resize, content and reset passed (${draft ? "new conversation with image" : "follow-up sent from moved position"})`);
}
