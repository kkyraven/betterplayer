export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="page">
      <div className="page-hd">
        <h1>{title}</h1>
        <span className="faint">{note}</span>
      </div>
    </div>
  )
}
