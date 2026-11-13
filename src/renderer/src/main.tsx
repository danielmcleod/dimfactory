// Renderer entry: applies main's initial theme to <html> before the first render, so
// the first paint matches the window's backgroundColor, refuses file drops, keeps the keyboard focus through a
// control's busy moment, follows the configured stream font size, offers the Diff tab's highlighter check to
// the packaged smoke test, then mounts the app in StrictMode.
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { installDiffSelfCheck } from './components/diff/selfCheckHook.ts'
import { installDropGuard } from './lib/dropGuard.ts'
import { installFocusKeeper } from './lib/focusKeeper.ts'
import { installStreamFontSize } from './lib/streamFont.ts'
import { applyTheme, readInitialTheme } from './lib/theme.ts'
import { setThemeState } from './state/actions.ts'
import { loadExperience } from './state/experience.ts'

const theme = readInitialTheme()
applyTheme(theme)
setThemeState(theme)
installDropGuard()
// Accessibility: a control that turns disabled while it works gives the keyboard focus back to itself afterwards.
installFocusKeeper()
// The stream font size (Settings → Appearance) from the user's dimfactory.json, now and after each config change.
installStreamFontSize()
// `--smoke-test` asks the Diff tab's worker to highlight a diff (it loads nothing until then).
installDiffSelfCheck()

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root element')
const mount = root
// Easy or Full (and whether a new user is asked once) before the first render, so the Dashboard never shows the
// composer and then swaps in the welcome card; a core that does not answer soon leaves it to the first config event.
const EXPERIENCE_WAIT_MS = 1500
void Promise.race([
  loadExperience().catch(() => false),
  new Promise((r) => setTimeout(r, EXPERIENCE_WAIT_MS)),
]).then(() => {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
