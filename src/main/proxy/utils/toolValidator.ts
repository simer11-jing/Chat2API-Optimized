/**
 * Tool Call Validator
 * Validates tool calls against provided tool definitions
 */

import { ChatCompletionTool, ToolCall } from '../types'

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  correctedToolCalls?: ToolCall[]
}

/**
 * Validate and correct tool calls
 */
export function validateToolCalls(
  toolCalls: ToolCall[],
  tools: ChatCompletionTool[]
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const corrected: ToolCall[] = []

  if (!tools || tools.length === 0) {
    return { valid: true, errors: [], warnings: [] }
  }

  const validToolNames = new Set(tools.map(t => t.function.name))
  const toolSchemas = new Map(tools.map(t => [t.function.name, t.function.parameters]))

  for (const tc of toolCalls) {
    const correctedTc = { ...tc }
    let hasErrors = false

    // Check tool name exists
    if (!validToolNames.has(tc.function.name)) {
      const similar = findSimilarToolName(tc.function.name, Array.from(validToolNames))
      if (similar) {
        warnings.push(`Tool "${tc.function.name}" not found, corrected to "${similar}"`)
        correctedTc.function = { ...correctedTc.function, name: similar }
      } else {
        errors.push(`Unknown tool: "${tc.function.name}"`)
        hasErrors = true
      }
    }

    // Validate arguments
    const schema = toolSchemas.get(correctedTc.function.name)
    if (schema && !hasErrors) {
      try {
        const args = JSON.parse(tc.function.arguments)
        const schemaErrors = validateAgainstSchema(args, schema)
        if (schemaErrors.length > 0) {
          warnings.push(...schemaErrors)
        }
      } catch {
        errors.push(`Invalid JSON in arguments for tool "${tc.function.name}"`)
        hasErrors = true
      }
    }

    if (!hasErrors) {
      corrected.push(correctedTc)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    correctedToolCalls: corrected.length > 0 ? corrected : undefined,
  }
}

/**
 * Find a similar tool name using fuzzy matching
 */
function findSimilarToolName(name: string, validNames: string[]): string | null {
  const lowerName = name.toLowerCase()

  // Check for namespace matches (e.g., "read_file" vs "default_api:read_file")
  const nameWithoutPrefix = name.split(':').pop()
  for (const valid of validNames) {
    const validWithoutPrefix = valid.split(':').pop()
    if (nameWithoutPrefix && validWithoutPrefix && nameWithoutPrefix === validWithoutPrefix) {
      return valid
    }
  }

  // Check for common delimiter variations (e.g., "read-file" vs "read_file")
  const normalized = lowerName.replace(/[-_]/g, '')
  for (const valid of validNames) {
    const validNormalized = valid.toLowerCase().replace(/[-_]/g, '')
    if (normalized === validNormalized) {
      return valid
    }
  }

  // Check for substring matches (name contained in valid name or vice versa)
  for (const valid of validNames) {
    if (valid.toLowerCase().includes(lowerName) || lowerName.includes(valid.toLowerCase())) {
      return valid
    }
  }

  return null
}

/**
 * Basic schema validation - check required properties
 */
function validateAgainstSchema(args: any, schema: any): string[] {
  const errors: string[] = []

  if (!schema || !schema.properties) return errors

  // Check required properties
  if (schema.required && Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (args[req] === undefined) {
        errors.push(`Missing required property: ${req}`)
      }
    }
  }

  return errors
}

/**
 * Generate retry prompt when tool call parsing fails
 */
export function generateRetryPrompt(
  tools: ChatCompletionTool[],
  format: 'bracket' | 'xml' = 'bracket'
): string {
  const toolNames = tools.map(t => t.function.name).join(', ')

  if (format === 'xml') {
    return `\n\n[SYSTEM] Your previous tool call was malformed. Please retry with EXACTLY this format:

<tool_use>
<name>exact_tool_name</name>
<arguments>{"arg":"value"}</arguments>
</tool_use>

Available tools: ${toolNames}

Your response must be valid XML with proper JSON arguments.`
  }

  return `\n\n[SYSTEM] Your previous tool call was malformed. Please retry with EXACTLY this format:

[call:exact_tool_name]{"arg":"value"}[/call]

Available tools: ${toolNames}

Rules:
- JSON must be on ONE line
- No markdown code blocks
- Use exact tool name from list`
}
