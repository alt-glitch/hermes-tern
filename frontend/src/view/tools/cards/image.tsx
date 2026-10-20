// A tool that shows an image (vision, image generation, a browser screenshot): the image itself.

import type { JSX } from '@stencil-hq/tern'

import { localSource } from '../../../media.js'
import type { ToolCall } from '../../../model.js'
import { clip, nonEmpty } from '../../format.js'
import type { Card } from '../types.js'

/** The image itself, open; what the tool said of it under it (not the JSON it came in). */
export function imageCard(
  call: ToolCall,
  result: Record<string, unknown> | undefined,
  look: { name: string; title: string },
  src: string | undefined
): Card {
  const said = call.status === 'running' ? undefined : (nonEmpty(result?.analysis) ?? nonEmpty(result?.text_summary))

  return {
    ...look,
    body: [
      ...(src ? [imageNode(call, src)] : []),
      ...(said ? [<text key="said" lines={6} spans={[{ s: 'muted', t: clip(said, { mark: 'line', max: 2000 }) }]} wrap="word" />] : [])
    ],
    folded: false,
    target: nonEmpty(call.args.prompt) ?? nonEmpty(call.args.question) ?? (call.context || undefined),
    targetKind: 'text'
  }
}

/** The image a call showed; a click opens it large in Tern's lightbox. A URL shows once its bytes came. */
function imageNode(call: ToolCall, src: string): JSX.Element {
  const source = localSource(src) ?? call.image
  const alt = nonEmpty(call.args.prompt) ?? 'Image'

  if (source) {
    return <image alt={clip(alt, { mark: 'line', max: 200 })} key="image" role="hermes.tool.image" {...source} />
  }

  // A data URL is no address to show; an http(s) one is, as a link.
  const link = /^https?:\/\//i.test(src) ? [{ href: src, t: clip(src, { mark: 'line', max: 120 }) }] : []

  return (
    <text
      key="image"
      spans={[{ s: 'muted', t: call.image === null ? `Could not load the image${link.length ? ': ' : '.'}` : 'Loading the image…' }, ...(call.image === null ? link : [])]}
      wrap="word"
    />
  )
}
