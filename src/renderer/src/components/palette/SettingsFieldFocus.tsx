// Settings deep links focus their row (e.g. `#/settings/vendors/codex?field=path`, also from the palette's Settings
// index). Each navigation to `#/settings/<section>[/<sub>]?field=<id>` (from the
// palette, a link, or core's settings_link) focuses that row's control once its section shows it, bringing it under
// the header only if it is out of view (followUp.ts). A vendor card's own fields are VendorCard's
// (vendors/deepLink.ts), so they are left to it.
import { useEffect } from 'react'
import { useRoute } from '../../lib/router.ts'
import { findSection } from '../../pages/settings/sections.ts'
import { vendorTarget } from '../../pages/settings/vendors/deepLink.ts'
import { focusSettingsField } from './followUp.ts'

export function SettingsFieldFocus(): null {
  const route = useRoute()
  useEffect(() => {
    if (route.name !== 'settings') return
    const field = route.query['field']
    if (field === undefined || field === '') return
    if (vendorTarget(route) !== null) return
    const section = findSection(route.section)
    if (section === undefined) return
    focusSettingsField(section.id, field, route.subpath[0])
  }, [route])
  return null
}
