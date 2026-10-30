import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@packages/ui';
import { Check, Dumbbell, Leaf, UtensilsCrossed } from 'lucide-react';

export function TodayPreview() {
  return (
    <div className="today-preview">
      <div className="preview-heading">
        <span className="preview-brand">Corner</span>
        <span>Monday, 26 October</span>
      </div>
      <p className="preview-greeting">In your corner, Sam.</p>
      <section className="preview-training" aria-label="Example training week">
        <div className="preview-section-title">
          <h3>Your training week</h3>
          <Dumbbell size={20} aria-hidden="true" />
        </div>
        <ol className="preview-week" aria-label="Example weekly schedule">
          {[
            ['Monday', 'Strength'],
            ['Tuesday', 'Rest'],
            ['Wednesday', 'Strength'],
            ['Thursday', 'Rest'],
            ['Friday', 'Strength'],
            ['Saturday', 'Rest'],
            ['Sunday', 'Rest'],
          ].map(([day, activity], index) => (
            <li
              key={day}
              aria-label={`${day}: ${activity}`}
              className={index === 0 ? 'selected-day' : undefined}
            >
              <span aria-hidden="true">{day?.slice(0, 1)}</span>
              {activity === 'Strength' ? (
                <Dumbbell size={17} aria-hidden="true" />
              ) : (
                <Leaf size={17} aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
        <div className="preview-workout">
          <div>
            <strong>Upper body</strong>
            <span>3 exercises · 45 min planned</span>
          </div>
          <span>Planned</span>
        </div>
      </section>
      <section className="preview-nutrition" aria-label="Example daily nutrition">
        <div className="preview-section-title">
          <h3>Daily nutrition</h3>
          <UtensilsCrossed size={18} aria-hidden="true" />
        </div>
        <p className="preview-energy">
          <strong>1,640</strong> / 2,400 kcal target
        </p>
        <dl className="preview-macros">
          <div>
            <dt>Protein</dt>
            <dd>112 g</dd>
          </div>
          <div>
            <dt>Carbs</dt>
            <dd>190 g</dd>
          </div>
          <div>
            <dt>Fat</dt>
            <dd>48 g</dd>
          </div>
        </dl>
        <div className="preview-food">
          <Check size={17} aria-hidden="true" />
          <span>
            Chicken & rice bowl <small>Lunch · 1 serving logged</small>
          </span>
          <strong>620 kcal</strong>
        </div>
      </section>
    </div>
  );
}

export function WorkoutPreview() {
  return (
    <div className="workout-preview">
      <div className="workout-preview-heading">
        <div>
          <h3>Upper body</h3>
          <p>Monday, 26 October · 43 min recorded</p>
        </div>
        <Badge variant="secondary">Completed</Badge>
      </div>
      <Table>
        <caption className="sr-only">
          Synthetic workout: planned targets and recorded results
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Exercise</TableHead>
            <TableHead scope="col">Target</TableHead>
            <TableHead scope="col">Recorded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Bench press</TableCell>
            <TableCell>3 × 8</TableCell>
            <TableCell>
              8 / 8 / 7 <span className="load-note">at 60 kg</span>
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Seated cable row</TableCell>
            <TableCell>3 × 10</TableCell>
            <TableCell>
              10 / 10 / 10 <span className="load-note">at 45 kg</span>
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Lateral raise</TableCell>
            <TableCell>3 × 12</TableCell>
            <TableCell>
              12 / 12 / 11 <span className="load-note">at 6 kg per hand</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="workout-note">“Keep the same load next time. Work toward all eight reps.”</p>
      <p className="sample-caption">Illustrative workout · synthetic data</p>
    </div>
  );
}
