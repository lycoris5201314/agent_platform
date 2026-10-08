"use client";

import { useState } from "react";

/** Local data/blob URLs must be decoded by the image element, not a plugin. */
export function LocalImage({ src, alt }: { src: string; alt: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (failedSource === src) return <span className="image-load-error" role="status">图片无法预览，请检查文件是否损坏</span>;
  // Local files have no public URL or fixed dimensions for Next's image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} draggable={false} onError={() => setFailedSource(src)} />;
}
