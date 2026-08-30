'use client'

import { useMemo } from 'react'
import { Plus, Trash2, Layers } from 'lucide-react'
import { Button, Input, Select } from '@/components/ui/primitives'
import { FIELDS, FIELD_MAP, type FilterCondition, type FilterGroup, type FilterOperator, isGroup } from '@/server/filters/schema'
import { cn } from '@/lib/utils'

/**
 * Composable AND/OR filter builder (§8).
 *
 * Groups can nest, so "City = London AND (SEO score < 50 OR Speed score < 40)"
 * is expressible. The shape produced here is exactly the DSL the server
 * validates and compiles — there is no translation step to drift out of sync.
 */

const OP_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  contains: 'contains',
  startsWith: 'starts with',
  in: 'is any of',
  notIn: 'is none of',
  isNull: 'is empty',
  notNull: 'is not empty',
  between: 'between',
}

export function FilterBuilder({
  value,
  onChange,
  depth = 0,
}: {
  value: FilterGroup
  onChange: (next: FilterGroup) => void
  depth?: number
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, typeof FIELDS>()
    for (const f of FIELDS) {
      const arr = map.get(f.group) ?? []
      arr.push(f)
      map.set(f.group, arr)
    }
    return Array.from(map.entries())
  }, [])

  function update(index: number, next: FilterCondition | FilterGroup) {
    const conditions = [...value.conditions]
    conditions[index] = next
    onChange({ ...value, conditions })
  }

  function remove(index: number) {
    onChange({
      ...value,
      conditions: value.conditions.filter((_, i) => i !== index),
    })
  }

  function addCondition() {
    onChange({
      ...value,
      conditions: [
        ...value.conditions,
        { field: 'city', op: 'eq', value: '' } as FilterCondition,
      ],
    })
  }

  function addGroup() {
    onChange({
      ...value,
      conditions: [
        ...value.conditions,
        { logic: value.logic === 'AND' ? 'OR' : 'AND', conditions: [] },
      ],
    })
  }

  return (
    <div
      className={cn(
        'rounded-lg',
        depth > 0 && 'border border-dashed border-border-strong bg-surface-2/50 p-3',
      )}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {(['AND', 'OR'] as const).map((logic) => (
            <button
              key={logic}
              type="button"
              onClick={() => onChange({ ...value, logic })}
              className={cn(
                'px-2.5 py-1 text-2xs font-semibold transition-colors',
                value.logic === logic
                  ? 'bg-accent text-accent-fg'
                  : 'bg-surface text-muted hover:bg-surface-2',
              )}
            >
              {logic}
            </button>
          ))}
        </div>
        <span className="text-2xs text-subtle">
          {value.logic === 'AND'
            ? 'All of these must match'
            : 'Any one of these may match'}
        </span>
      </div>

      <div className="space-y-2">
        {value.conditions.map((node, i) =>
          isGroup(node) ? (
            <div key={i} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <FilterBuilder
                  value={node}
                  onChange={(next) => update(i, next)}
                  depth={depth + 1}
                />
              </div>
              <Button variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove group">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <ConditionRow
              key={i}
              condition={node}
              groups={grouped}
              onChange={(next) => update(i, next)}
              onRemove={() => remove(i)}
            />
          ),
        )}
      </div>

      <div className="mt-2.5 flex gap-2">
        <Button variant="subtle" size="sm" onClick={addCondition}>
          <Plus className="h-3.5 w-3.5" />
          Condition
        </Button>
        {depth < 2 && (
          <Button variant="ghost" size="sm" onClick={addGroup}>
            <Layers className="h-3.5 w-3.5" />
            Nested group
          </Button>
        )}
      </div>
    </div>
  )
}

function ConditionRow({
  condition,
  groups,
  onChange,
  onRemove,
}: {
  condition: FilterCondition
  groups: Array<[string, typeof FIELDS]>
  onChange: (next: FilterCondition) => void
  onRemove: () => void
}) {
  const def = FIELD_MAP.get(condition.field)
  const needsValue = condition.op !== 'isNull' && condition.op !== 'notNull'
  const isRange = condition.op === 'between'
  const isMulti = condition.op === 'in' || condition.op === 'notIn'

  function changeField(fieldId: string) {
    const nextDef = FIELD_MAP.get(fieldId)
    // Operators are field-specific; keep the current one only if it is valid.
    const op = nextDef?.operators.includes(condition.op)
      ? condition.op
      : (nextDef?.operators[0] ?? 'eq')
    onChange({ field: fieldId, op, value: nextDef?.kind === 'boolean' ? true : '' })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-2 py-2">
      <Select
        value={condition.field}
        onChange={(e) => changeField(e.target.value)}
        className="h-8 w-[190px] text-[13px]"
        aria-label="Field"
      >
        {groups.map(([group, fields]) => (
          <optgroup key={group} label={group}>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>

      <Select
        value={condition.op}
        onChange={(e) =>
          onChange({ ...condition, op: e.target.value as FilterOperator })
        }
        className="h-8 w-[130px] text-[13px]"
        aria-label="Operator"
      >
        {(def?.operators ?? ['eq']).map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </Select>

      {needsValue && def && (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {def.kind === 'boolean' ? (
            <Select
              value={String(condition.value ?? true)}
              onChange={(e) => onChange({ ...condition, value: e.target.value === 'true' })}
              className="h-8 w-[110px] text-[13px]"
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          ) : def.options && !isRange ? (
            <Select
              value={String(Array.isArray(condition.value) ? condition.value[0] ?? '' : condition.value ?? '')}
              onChange={(e) =>
                onChange({
                  ...condition,
                  value: isMulti ? [e.target.value] : e.target.value,
                })
              }
              className="h-8 min-w-[160px] text-[13px]"
            >
              <option value="">Select…</option>
              {def.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : isRange ? (
            <>
              <Input
                className="h-8 w-24 text-[13px]"
                type={def.kind === 'date' ? 'date' : 'number'}
                value={String((condition.value as unknown[])?.[0] ?? '')}
                onChange={(e) =>
                  onChange({
                    ...condition,
                    value: [e.target.value, (condition.value as unknown[])?.[1] ?? ''],
                  })
                }
                placeholder="From"
              />
              <span className="text-2xs text-subtle">and</span>
              <Input
                className="h-8 w-24 text-[13px]"
                type={def.kind === 'date' ? 'date' : 'number'}
                value={String((condition.value as unknown[])?.[1] ?? '')}
                onChange={(e) =>
                  onChange({
                    ...condition,
                    value: [(condition.value as unknown[])?.[0] ?? '', e.target.value],
                  })
                }
                placeholder="To"
              />
            </>
          ) : (
            <Input
              className="h-8 min-w-[140px] flex-1 text-[13px]"
              type={def.kind === 'number' ? 'number' : def.kind === 'date' ? 'date' : 'text'}
              value={String(condition.value ?? '')}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              placeholder={def.kind === 'number' ? '0' : 'Value'}
            />
          )}
        </div>
      )}

      {def?.description && (
        <span className="hidden text-2xs text-subtle xl:inline">{def.description}</span>
      )}

      <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Remove condition">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

export function countConditions(group: FilterGroup): number {
  return group.conditions.reduce<number>(
    (n, node) => n + (isGroup(node) ? countConditions(node) : 1),
    0,
  )
}
