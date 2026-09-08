import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ content }: { content: string }) {
  return <div className="message-content markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children, ...props }) => {
          const external = Boolean(href && /^https?:\/\//i.test(href));
          return <a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined} {...props}>{children}</a>;
        },
        table: ({ children, ...props }) => <div className="markdown-table"><table {...props}>{children}</table></div>,
      }}
    >{content}</ReactMarkdown>
  </div>;
}
