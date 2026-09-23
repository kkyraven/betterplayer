export function watchSocket(url: string, report: (running: boolean) => void): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let timeout: ReturnType<typeof setTimeout>
  let retry: ReturnType<typeof setTimeout>
  const close = () => {
    if (!socket) return
    socket.onopen = socket.onerror = socket.onclose = null
    socket.close()
    socket = null
  }
  const probe = () => {
    const finish = (running: boolean) => {
      clearTimeout(timeout)
      close()
      if (stopped) return
      report(running)
      retry = setTimeout(probe, 2000)
    }
    try {
      socket = new WebSocket(url)
      socket.onopen = () => finish(true)
      socket.onerror = socket.onclose = () => finish(false)
      timeout = setTimeout(() => finish(false), 1500)
    } catch {
      finish(false)
    }
  }
  retry = setTimeout(probe, 300)
  return () => {
    stopped = true
    clearTimeout(timeout)
    clearTimeout(retry)
    close()
  }
}
