// A GitHub comment or PR description, drawn as GitHub draws it. GitHub Markdown carries raw HTML
// (bots such as Greptile write most of a review in it), and Tern's `md` shows raw HTML as literal
// text. So the body goes through the pipeline T3 Code's PR panel uses (remark-gfm, then rehype-raw
// and GitHub's sanitize schema): `<details>` becomes a fold, and the rest becomes the Markdown it
// means again (hast-util-to-mdast), which `md` draws natively.

import type { JSX } from '@stencil-hq/tern'
import type { Element, ElementContent, Root as HastRoot, RootContent } from 'hast'
import { toMdast } from 'hast-util-to-mdast'
import { findAndReplace, type FindAndReplaceList, type FindAndReplaceTuple } from 'mdast-util-find-and-replace'
import { toText } from 'hast-util-to-text'
import type { Link, Root as MdRoot } from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { SKIP, visit } from 'unist-util-visit'

/** A run of Markdown, or a `<details>` fold with its own parts. */
export type BodyPart = { kind: 'md'; text: string } | { kind: 'details'; summary: string; open: boolean; parts: BodyPart[] }

const schema = {
  ...defaultSchema,
  // GitHub keeps `open` on a fold; the default schema drops it.
  attributes: { ...defaultSchema.attributes, details: [...(defaultSchema.attributes?.['details'] ?? []), 'open'] },
  // Drawn as Tern's own fold and checkboxes, so the ids clobber nothing.
  clobberPrefix: ''
}

const pipeline = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitize, schema)

/** The body as sanitized HTML (hast), as GitHub renders it. */
export function bodyHast(src: string): HastRoot {
  return pipeline.runSync(pipeline.parse(src))
}

const isDetails = (n: RootContent | ElementContent): boolean => n.type === 'element' && n.tagName === 'details'

/** Whether `n` holds a `<details>` somewhere below it (a fold inside a list item, say). */
function holdsDetails(n: RootContent | ElementContent): boolean {
  return n.type === 'element' && n.children.some(c => isDetails(c) || holdsDetails(c))
}

/** Where `#123` and `@login` point: the PR's repository (`https://github.com/owner/repo`). */
export interface BodyLinks {
  repo?: string
}

/**
 * GitHub's references as links, as GitHub (and T3 Code) link them: `#123` to the repository's
 * issue or PR, `@login` to the profile. Tern reads `#141402` as a color and chips it, so a word
 * joiner (U+2060, invisible) follows the `#`.
 */
function autolink(mdast: MdRoot, links: BodyLinks) {
  const host = links.repo?.match(/^https?:\/\/[^/]+/)?.[0] ?? 'https://github.com'

  const link = (text: string, url: string): Link => ({ children: [{ type: 'text', value: text }], type: 'link', url })
  const list: FindAndReplaceList = [
    ...(links.repo ? [[/(?<![\w&/#])#(\d+)\b/g, (_: string, n: string) => link(`#\u2060${n}`, `${links.repo}/issues/${n}`)] satisfies FindAndReplaceTuple] : []),
    [/(?<![\w/@.])@([a-z\d](?:[a-z\d-]{0,38}))\b(?!\.\w)/gi, (all: string, login: string) => link(all, `${host}/${login}`)]
  ]

  findAndReplace(mdast, list, { ignore: ['link', 'linkReference', 'inlineCode', 'code'] })
}

/** Nodes as Markdown: what GitHub drew, said in the dialect Tern's `md` draws. */
function markdown(nodes: (RootContent | ElementContent)[], links: BodyLinks): string {
  const tree = toMdast({ children: nodes, type: 'root' })
  // A hast root comes back as an mdast root; the wrap only satisfies the type.
  const mdast: MdRoot = tree.type === 'root' ? tree : { children: [tree], type: 'root' }

  autolink(mdast, links)

  // A link around an image (a status badge) reads as the image's words, a dot between badges.
  visit(mdast, 'link', (link, i, parent) => {
    let badge = false

    visit(link, 'image', (image, j, holder) => {
      badge = true
      if (j !== undefined) {
        holder?.children.splice(j, 1, { type: 'text', value: image.alt ?? '' })
      }
    })

    if (badge && parent && i !== undefined) {
      parent.children.splice(i + 1, 0, { type: 'text', value: ' · ' })

      return [SKIP, i + 2]
    }

    return SKIP
  })

  return toMarkdown(mdast, { extensions: [gfmToMarkdown()] })
    .replace(/\n{3,}/g, '\n\n')
    // GitHub's alerts (`> [!NOTE]`), which Tern draws as callouts: the round trip escaped the
    // marker and joined its line to the next.
    .replace(/^> \\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/gim, '> [!$1]\n> ')
    .trim()
}

function parts(nodes: (RootContent | ElementContent)[], links: BodyLinks): BodyPart[] {
  const out: BodyPart[] = []
  let run: (RootContent | ElementContent)[] = []

  const flush = () => {
    const text = run.length ? markdown(run, links) : ''

    if (text) {
      out.push({ kind: 'md', text })
    }

    run = []
  }

  for (const n of nodes) {
    if (n.type === 'element' && n.tagName === 'details') {
      flush()

      const summary = n.children.find((c): c is Element => c.type === 'element' && c.tagName === 'summary')

      out.push({
        kind: 'details',
        open: n.properties.open !== undefined && n.properties.open !== false,
        parts: parts(n.children.filter(c => c !== summary), links),
        summary: (summary ? toText(summary) : '').replace(/\s+/g, ' ').trim() || 'Details'
      })
    } else if (n.type === 'element' && holdsDetails(n)) {
      // A wrapper (a `<div>`, a `<p>`) around a fold: its children take its place.
      flush()
      out.push(...parts(n.children, links))
    } else {
      run.push(n)
    }
  }

  flush()

  return out
}

/** A GitHub body as parts: Markdown runs and `<details>` folds (nested ones too). */
export function parseBody(src: string, links: BodyLinks = {}): BodyPart[] {
  return parts(bodyHast(src).children, links)
}

/** The body's nodes: `md` for each run, a collapsible `section` for each fold. */
export function bodyNodes(src: string, key = 'body', empty = 'No description.', links: BodyLinks = {}): JSX.Element[] {
  const ps = src.trim() ? parseBody(src, links) : []

  return ps.length ? partNodes(ps, key) : [<text key={key} spans={[{ s: 'muted', t: empty }]} />]
}

function partNodes(ps: BodyPart[], key: string): JSX.Element[] {
  return ps.map((p, i) =>
    p.kind === 'md' ? (
      <md key={`${key}${i}`} text={p.text} />
    ) : (
      <section collapsed={!p.open} collapsible head={p.summary} key={`${key}${i}`} role="hermes.pr.details">
        {partNodes(p.parts, 'p')}
      </section>
    )
  )
}
