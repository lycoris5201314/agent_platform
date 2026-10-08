import type { BrowserWindow } from "electron";

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
    document.querySelector('.attachment-preview-card button').click();
    await new Promise(r => setTimeout(r, 50));
    if (document.querySelector('.attachment-preview-card')) throw new Error('Attachment removal failed');
    [...document.querySelectorAll('.draft-conversation-header button')].find(b => b.textContent.includes('丢弃草稿')).click();
  })()`);
  console.log("Native image file drop and sidebar preview decoded successfully; prompt remains editable after dragging");
}
