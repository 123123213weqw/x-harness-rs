/** Protocol ids use Zod's native nominal string brand; wire values remain strings. */
import type { z } from 'zod'
export type Branded<B extends string> = string & z.core.$brand<B>
