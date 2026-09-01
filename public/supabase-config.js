// supabase-config.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://drwegageyjcadegqcaqv.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRyd2VnYWdleWpjYWRlZ3FjYXF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5NzI0MDYsImV4cCI6MjA4ODU0ODQwNn0.EbkbxFqaPi579F6kjP2b7bvyvPVV_3PcQYQJm0ao7f8'

export const supabase = createClient(supabaseUrl, supabaseKey)