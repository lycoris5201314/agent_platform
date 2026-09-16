type AttachmentPreviewMap = Record<string, string>;

const imageAttachmentPattern = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i;

export function isPreviewableImageAttachment(filePath: string): boolean {
  return imageAttachmentPattern.test(filePath);
}

function attachmentName(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) || filePath;
}

export function AttachmentTray({ files, previews, onRemove }: { files: string[]; previews: AttachmentPreviewMap; onRemove: (filePath: string) => void }) {
  if (!files.length) return null;
  return <div className="attachment-previews" aria-label="待发送附件">
    {files.map((filePath) => {
      const preview = previews[filePath];
      const name = attachmentName(filePath);
      return <div className={`attachment-preview-card ${preview ? "image" : "file"}`} key={filePath} title={filePath}>
        {preview
          ? <object data={preview} type="image/*" aria-label={name} />
          : <div className="attachment-file-icon"><span>{isPreviewableImageAttachment(filePath) ? "图片" : (name.split(".").at(-1) || "文件").slice(0, 5).toUpperCase()}</span></div>}
        <span className="attachment-preview-name">{name}</span>
        <button type="button" aria-label={`移除 ${name}`} title="移除附件" onClick={() => onRemove(filePath)}>×</button>
      </div>;
    })}
  </div>;
}
