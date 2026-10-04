// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import type { DomProfile } from '@shared/dom'
import { cx } from '@/lib/cx'

export function Portrait({ dom, src, className }: { dom: Pick<DomProfile, 'name' | 'portrait'>; src?: string | null; className?: string }) {
  const image = src ?? dom.portrait
  if (image) return <img className={cx('dom-plate', className)} src={image} alt="" draggable={false} />
  return (
    <span className={cx('dom-plate', 'empty', className)} aria-hidden>
      {(dom.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}
