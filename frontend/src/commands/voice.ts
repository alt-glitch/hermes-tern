// `/voice` in Tern: dictation into this pane's composer. Hermes' /voice turns on a session's voice
// mode, whose push-to-talk (`voice.record`) the shared gateway does not serve and whose spoken
// replies a local session never plays; here `/voice on` arms the record key, and the words land
// in the composer for the user to read and send.

import type { ChatPorts } from '../app/ports.js'
import { configuredRecordKey } from '../hermes/dictation.js'

/** What `/voice` reaches of the app. */
export type VoiceHost = Pick<ChatPorts, 'dictation' | 'gw' | 'notice' | 'session'>

/** `/voice [on|off|status]`. */
export async function voiceCommand(host: VoiceHost, arg: string) {
  const { dictation } = host

  switch (arg.trim().toLowerCase()) {
    case 'on':
      await dictation.enable(await configuredRecordKey(host.gw, host.session.ref.live))

      return

    case 'off':
      dictation.disable()
      host.notice('Dictation off.')

      return

    case 'tts':
      host.notice('Tern does not read replies aloud. /voice on turns on dictation into the composer.', 'warning')

      return

    case '':
    case 'status':
      host.notice(
        dictation.phase === 'off'
          ? 'Dictation is off. /voice on turns it on: the record key then dictates into the composer.'
          : `Dictation is on. ${dictation.key.label} starts and ends a capture, esc cancels it.`
      )

      return

    default:
      host.notice('Usage: /voice [on|off|status]', 'warning')
  }
}
