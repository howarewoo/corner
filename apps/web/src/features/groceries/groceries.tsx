import { useMemo } from 'react';
import type { AppState } from '@packages/shared/types';
import { groceryList, mondayOf } from '@packages/shared/domain';
import { ArrowDownToLine, ArrowRight, CheckCircle2, Copy, ShoppingBasket } from 'lucide-react';
import {
  Button,
  Card,
  Checkbox,
  Label,
  Progress as SharedProgress,
  WorkspaceHeader,
} from '@packages/ui';
import type { Mutate, View } from '../workspace/types';
import { download, formatDate, num } from '../workspace/utils';
import { DateControls, Empty } from '../workspace/workspace-ui';

export default function Groceries({
  state,
  selectedDate,
  setSelectedDate,
  disabled,
  navigate,
  mutate,
  copyText,
}: {
  state: AppState;
  selectedDate: string;
  setSelectedDate: (date: string) => void;
  disabled: boolean;
  navigate: (view: View) => void;
  mutate: Mutate;
  copyText: (text: string, success?: string) => Promise<void>;
}) {
  const weekStart = mondayOf(selectedDate);
  const groceries = useMemo(() => groceryList(state, weekStart), [state, weekStart]);
  const groceryGroups = useMemo(() => {
    const groups: Record<string, typeof groceries> = {};
    groceries.forEach((item) => {
      (groups[item.aisle || 'Other'] ||= []).push(item);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [groceries]);
  const checkedGroceries = groceries.filter(
    (item) => state.groceryChecks[`${weekStart}|${item.key}`],
  ).length;
  const groceryText = `CORNER · WEEKLY GROCERY LIST\n${formatDate(weekStart, { month: 'long', day: 'numeric', year: 'numeric' })}\n\n${groceryGroups.map(([aisle, items]) => `${aisle.toUpperCase()}\n${items.map((item) => `${state.groceryChecks[`${weekStart}|${item.key}`] ? '[x]' : '[ ]'} ${item.name} — ${num(item.quantity, 2)} ${item.unit}${item.notes.length ? ` (${item.notes.join('; ')})` : ''}`).join('\n')}`).join('\n\n')}\n\nAmounts reflect the recipes and portions in your meal plan. Check your pantry and package sizes before shopping.`;
  return (
    <>
      <WorkspaceHeader
        title="Your grocery list."
        eyebrow="ONE TRIP. A BETTER WEEK."
        description="Everything your plan calls for, gathered in one place."
        actions={
          <>
            <DateControls date={selectedDate} setDate={setSelectedDate} week />
            <Button
              variant="outline"
              size="default"
              disabled={!groceries.length}
              onClick={() => void copyText(groceryText, 'Grocery list copied')}
            >
              <Copy size={16} />
              Copy list
            </Button>
          </>
        }
      />
      <div className="grocery-layout">
        <div>
          {groceries.length ? (
            <div className="grocery-groups">
              {groceryGroups.map(([aisle, items]) => (
                <Card className="panel grocery-group" key={aisle}>
                  <div className="grocery-group-heading">
                    <h2>{aisle}</h2>
                    <span>{items.length} items</span>
                  </div>
                  {items.map((item) => {
                    const key = `${weekStart}|${item.key}`,
                      checked = Boolean(state.groceryChecks[key]);
                    return (
                      <Label className={`grocery-item ${checked ? 'checked' : ''}`} key={item.key}>
                        <Checkbox
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={(checked) =>
                            void mutate({
                              type: 'grocery.check',
                              data: { key, checked: Boolean(checked) },
                            })
                          }
                        />
                        <span className="grocery-item-description">
                          <b>{item.name}</b>
                          {item.notes.length > 0 && <small>{item.notes.join(' · ')}</small>}
                        </span>
                        <strong>
                          {num(item.quantity, 2)} <span>{item.unit}</span>
                        </strong>
                      </Label>
                    );
                  })}
                </Card>
              ))}
            </div>
          ) : (
            <Card className="panel">
              <Empty
                icon={ShoppingBasket}
                title="Your list starts with a plan"
                action={
                  <Button variant="default" size="sm" onClick={() => navigate('planner')}>
                    Build your meal plan <ArrowRight size={15} />
                  </Button>
                }
              >
                Add recipes to this week’s planner, and their ingredients will appear here.
              </Empty>
            </Card>
          )}
        </div>
        <aside className="grocery-summary">
          <span className="grocery-summary-icon">
            <ShoppingBasket size={29} strokeWidth={1.4} />
          </span>
          <div className="eyebrow">This week’s shop</div>
          <h2>Your shopping progress</h2>
          <div className="shopping-progress">
            <div>
              <span>In your basket</span>
              <strong>
                {checkedGroceries}
                <small> / {groceries.length}</small>
              </strong>
            </div>
            <SharedProgress
              value={groceries.length ? (checkedGroceries / groceries.length) * 100 : 0}
              aria-label="Shopping progress"
            />
          </div>
          <div className="shopping-tips">
            <p>
              <CheckCircle2 size={16} />
              <span>
                Check your pantry before you go. Quantities come from your planned portions.
              </span>
            </p>
            <p>
              <CheckCircle2 size={16} />
              <span>
                Shop meat and seafood by raw weight, and grains by dry weight where noted.
              </span>
            </p>
            <p>
              <CheckCircle2 size={16} />
              <span>
                Round up to available package sizes. Freeze later-week proteins and extra portions.
              </span>
            </p>
          </div>
          <Button
            variant="outline"
            size="default"
            disabled={!groceries.length}
            onClick={() => download(groceryText, `corner-groceries-${weekStart}.txt`, 'text/plain')}
            className="full-width"
          >
            <ArrowDownToLine size={16} />
            Download list
          </Button>
          <Button variant="link" size="default" onClick={() => navigate('planner')}>
            Adjust the meal plan <ArrowRight size={14} />
          </Button>
        </aside>
      </div>
    </>
  );
}
