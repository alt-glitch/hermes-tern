// A reply's text as Markdown runs and the files it shows. Hermes' convention for a file in a reply
// is a line `MEDIA:/path` (the desktop draws it inline; the Ink TUI prints it). Tern's `md` node
// draws no picture for `![…](…)`, so such a line, and a line that is only a Markdown image of a
// local file, become Tern's `media` viewer (images, SVG, PDF, video, audio, 3D models) in place.

export type ReplyPart = { kind: 'md'; text: string } | { kind: 'media'; path: string }

const MEDIA_LINE = /^\s*MEDIA:\s*(\S(?:.*\S)?)\s*$/
const IMAGE_LINE = /^\s*!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const VIEWABLE =
  /\.(png|jpe?g|gif|webp|bmp|avif|svg|pdf|mp4|mov|webm|m4v|mp3|wav|flac|ogg|m4a|aac|obj|ply|wrl|x3dv?|stl|gltf|glb|fbx|usdz?|usda|usdc|3ds)$/i

/** A Markdown image's target as a file Tern can show: a local path, never a URL. */
function localImage(target: string): string | undefined {
  if (/^[a-z][\w+.-]*:/i.test(target) && !/^file:\/\//i.test(target)) {
    return undefined
  }

  const path = /^file:\/\//i.test(target) ? decodeURIComponent(target.replace(/^file:\/\//i, '')) : target

  return VIEWABLE.test(path) ? path : undefined
}

/**
 * `text` split at its media lines, outside code fences. While the reply streams (`streaming`), its
 * last line may be half written, so it stays Markdown until a newline ends it.
 */
export function replyParts(text: string, streaming = false): ReplyPart[] {
  if (!text.includes('MEDIA:') && !text.includes('![')) {
    return [{ kind: 'md', text }]
  }

  const lines = text.split('\n')
  const parts: ReplyPart[] = []
  let run: string[] = []
  let fence: string | undefined

  const flush = () => {
    if (run.some(l => l.trim())) {
      parts.push({ kind: 'md', text: run.join('\n') })
    }

    run = []
  }

  lines.forEach((line, i) => {
    const mark = FENCE.exec(line)?.[1]

    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length)) {
        fence = undefined
      }

      run.push(line)

      return
    }

    if (mark) {
      fence = mark
      run.push(line)

      return
    }

    const done = !streaming || i < lines.length - 1
    const media = done ? (MEDIA_LINE.exec(line)?.[1] ?? localImage(IMAGE_LINE.exec(line)?.[1] ?? '')) : undefined

    if (media) {
      flush()
      parts.push({ kind: 'media', path: media.replace(/^`|`$/g, '') })
    } else {
      run.push(line)
    }
  })

  flush()

  return parts.length ? parts : [{ kind: 'md', text }]
}
