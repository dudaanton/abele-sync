import { afterAll } from 'vitest'
import { dropFileDatabase } from './tempDb.js'

// Every test file that reached Postgres leaves its own database behind until this runs.
afterAll(dropFileDatabase)
