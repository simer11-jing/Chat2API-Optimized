/**
 * Enhanced JSON Parser
 * Handles malformed JSON from LLM outputs with multiple repair strategies
 */

export interface ParseResult<T> {
  success: boolean
  data: T | null
  repaired: boolean
  repairMethod?: string
  rawInput: string
}

/**
 * Parse JSON with multiple repair strategies
 */
export function parseJsonWithRepair<T = any>(input: string): ParseResult<T> {
  if (!input || typeof input !== 'string') {
    return { success: false, data: null, repaired: false, rawInput: input }
  }

  // Strategy 0: Try direct parse
  try {
    return { success: true, data: JSON.parse(input), repaired: false, rawInput: input }
  } catch {}

  // Strategy 1: Strip markdown code blocks
  let processed = stripMarkdownCodeBlocks(input)
  if (processed !== input) {
    try {
      return { success: true, data: JSON.parse(processed), repaired: true, repairMethod: 'strip_markdown', rawInput: input }
    } catch {}
  }

  // Strategy 2: Fix newlines and control characters in strings
  processed = fixNewlinesInStrings(processed)
  try {
    return { success: true, data: JSON.parse(processed), repaired: true, repairMethod: 'fix_newlines', rawInput: input }
  } catch {}

  // Strategy 3: Add missing closing braces
  processed = addMissingBraces(processed)
  try {
    return { success: true, data: JSON.parse(processed), repaired: true, repairMethod: 'add_missing_braces', rawInput: input }
  } catch {}

  // Strategy 4: Remove trailing commas
  processed = removeTrailingCommas(processed)
  try {
    return { success: true, data: JSON.parse(processed), repaired: true, repairMethod: 'remove_trailing_commas', rawInput: input }
  } catch {}

  // Strategy 5: Fix unicode escapes
  processed = fixUnicodeEscapes(processed)
  try {
    return { success: true, data: JSON.parse(processed), repaired: true, repairMethod: 'fix_unicode_escapes', rawInput: input }
  } catch {}

  // Strategy 6: Fix single quotes (Python dict style)
  processed = fixSingleQuotes(processed)
  try {
    return { success: true, data: JSON.parse(processed), repaired: true, repairMethod: 'fix_single_quotes', rawInput: input }
  } catch {}

  return { success: false, data: null, repaired: false, rawInput: input }
}

function stripMarkdownCodeBlocks(input: string): string {
  return input
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

function fixNewlinesInStrings(input: string): string {
  let result = ''
  let inString = false
  let isEscaped = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (char === '\\' && !isEscaped) {
      isEscaped = true
      result += char
      continue
    }

    if (char === '"' && !isEscaped) {
      inString = !inString
      result += char
      isEscaped = false
      continue
    }

    if (inString && !isEscaped) {
      if (char === '\n') {
        result += '\\n'
        isEscaped = false
        continue
      }
      if (char === '\r') {
        result += '\\r'
        isEscaped = false
        continue
      }
      if (char === '\t') {
        result += '\\t'
        isEscaped = false
        continue
      }
    }

    result += char
    isEscaped = false
  }

  return result
}

function addMissingBraces(input: string): string {
  let openBraces = 0
  let openBrackets = 0
  let inString = false
  let isEscaped = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (char === '\\' && !isEscaped) {
      isEscaped = true
      continue
    }

    if (char === '"' && !isEscaped) {
      inString = !inString
    } else if (!inString) {
      if (char === '{') openBraces++
      else if (char === '}') openBraces--
      else if (char === '[') openBrackets++
      else if (char === ']') openBrackets--
    }

    isEscaped = false
  }

  let result = input
  while (openBrackets > 0) {
    result += ']'
    openBrackets--
  }
  while (openBraces > 0) {
    result += '}'
    openBraces--
  }

  return result
}

function removeTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, '$1')
}

function fixUnicodeEscapes(input: string): string {
  return input.replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
}

function fixSingleQuotes(input: string): string {
  // Only replace single quotes that look like JSON string delimiters
  // This is a simple heuristic that works for most cases
  let result = ''
  let inDoubleString = false
  let isEscaped = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    const prevChar = i > 0 ? input[i - 1] : ''

    if (char === '\\' && !isEscaped) {
      isEscaped = true
      result += char
      continue
    }

    if (char === '"' && !isEscaped) {
      inDoubleString = !inDoubleString
      result += char
      isEscaped = false
      continue
    }

    // Replace single quotes only outside double-quoted strings
    if (!inDoubleString && char === "'" && !isEscaped) {
      // Check if it looks like a string delimiter (after : or [ or , or {)
      if (prevChar === ':' || prevChar === '[' || prevChar === ',' || prevChar === '{' || /\s/.test(prevChar)) {
        result += '"'
        isEscaped = false
        continue
      }
      // Check if it's a closing quote (before : or ] or , or } or end)
      const nextChar = i < input.length - 1 ? input[i + 1] : ''
      if (nextChar === ':' || nextChar === ']' || nextChar === ',' || nextChar === '}' || nextChar === '' || /\s/.test(nextChar)) {
        result += '"'
        isEscaped = false
        continue
      }
    }

    result += char
    isEscaped = false
  }

  return result
}

/**
 * Extract JSON from mixed content
 */
export function extractJsonFromMixedContent(input: string): string | null {
  const startBrace = input.indexOf('{')
  if (startBrace === -1) return null

  let depth = 0
  let inString = false
  let isEscaped = false

  for (let i = startBrace; i < input.length; i++) {
    const char = input[i]

    if (char === '\\' && !isEscaped) {
      isEscaped = true
      continue
    }

    if (char === '"' && !isEscaped) {
      inString = !inString
    } else if (!inString) {
      if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          return input.substring(startBrace, i + 1)
        }
      }
    }

    isEscaped = false
  }

  return null
}

/**
 * Repair JSON with all strategies combined
 */
export function repairJson(input: string): string {
  let processed = input

  // Apply all repair strategies in sequence
  processed = stripMarkdownCodeBlocks(processed)
  processed = fixNewlinesInStrings(processed)
  processed = removeTrailingCommas(processed)
  processed = addMissingBraces(processed)
  processed = fixUnicodeEscapes(processed)

  return processed
}
