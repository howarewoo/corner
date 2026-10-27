'use client';

import { useState } from 'react';
import { ArrowUpRight, Clock3, Heart, Plus, Search, Sparkles } from 'lucide-react';
import type { AppState } from '@packages/workspace/types';
import type { Recipe } from '@packages/nutrition/types';
import {
  Badge,
  Button,
  Card,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
  WorkspaceHeader,
} from '@packages/ui';
import type { Mutate, Overlay, View } from '../workspace/types';
import { Empty, MacroLine, ResourceStatus, ResourcePaging } from '../workspace/workspace-ui';
import { useRecordPage } from '../workspace/resources';

export function useRecipeFilters() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  return { search, setSearch, category, setCategory, favoritesOnly, setFavoritesOnly };
}

export default function RecipeCollection({
  state,
  disabled,
  navigate,
  setOverlay,
  openRecipe,
  mutate,
  filters,
}: {
  state?: AppState;
  disabled: boolean;
  navigate: (view: View) => void;
  setOverlay: (overlay: Overlay) => void;
  openRecipe: (recipe: Recipe) => void;
  mutate: Mutate;
  filters: ReturnType<typeof useRecipeFilters>;
}) {
  const { search, setSearch, category, setCategory, favoritesOnly, setFavoritesOnly } = filters;
  const page = useRecordPage(
    {
      resource: 'recipes',
      search,
      category: category === 'all' ? undefined : (category as Recipe['category']),
      favorite: favoritesOnly || undefined,
      limit: 24,
    },
    !state,
  );
  const filteredRecipes = state
    ? state.recipes.filter(
        (recipe) =>
          (!favoritesOnly || recipe.favorite) &&
          (category === 'all' || recipe.category === category) &&
          `${recipe.name} ${recipe.tags.join(' ')} ${recipe.ingredients.map((i) => i.name).join(' ')}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      )
    : (page.data?.items ?? []);
  return (
    <>
      <WorkspaceHeader
        title="Your recipe collection."
        eyebrow="KEEP THE GOOD ONES"
        description="Reliable favorites, with enough variety to keep things interesting."
        actions={
          <>
            <Button variant="outline" size="default" onClick={() => navigate('studio')}>
              <Sparkles size={16} />
              Recipe studio
            </Button>
            <Button
              variant="default"
              size="default"
              onClick={() => setOverlay({ kind: 'recipeForm' })}
            >
              <Plus size={16} />
              New recipe
            </Button>
          </>
        }
      />
      <div className="recipe-toolbar">
        <InputGroup>
          <InputGroupAddon>
            <Search size={17} />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search recipes"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search recipes or ingredients…"
          />
        </InputGroup>
        <ToggleGroup
          aria-label="Filter recipe category"
          value={[category]}
          onValueChange={(values) => {
            if (values[0]) setCategory(String(values[0]));
          }}
        >
          {[
            ['all', 'All recipes'],
            ['breakfast', 'Breakfast'],
            ['main', 'Mains'],
            ['snack', 'Snacks & fuel'],
          ].map(([key, label]) => (
            <ToggleGroupItem key={key} value={key}>
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Toggle pressed={favoritesOnly} onPressedChange={setFavoritesOnly} aria-label="Favorites">
          <Heart size={15} fill={favoritesOnly ? 'currentColor' : 'none'} />
          Favorites
        </Toggle>
      </div>
      <div className="collection-meta">
        <span>
          {filteredRecipes.length} {filteredRecipes.length === 1 ? 'recipe' : 'recipes'}
          {!state ? ' on this page' : ''}
        </span>
        <span>Nutrition is approximate, per serving</span>
      </div>
      {!state && (!page.data || page.isError) ? (
        <ResourceStatus error={page.error} loading={page.isPending} retry={page.reload} />
      ) : filteredRecipes.length ? (
        <div className="recipe-grid">
          {filteredRecipes.map((recipe) => (
            <Card key={recipe.id} className="recipe-card">
              <div className={`recipe-card-top ${recipe.category}`}>
                <Badge variant="secondary" className="recipe-category">
                  {recipe.category === 'main'
                    ? 'Main meal'
                    : recipe.category === 'breakfast'
                      ? 'Breakfast'
                      : 'Snack & fuel'}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`favorite-button ${recipe.favorite ? 'is-favorite' : ''}`}
                  aria-label={`${recipe.favorite ? 'Unfavorite' : 'Favorite'} ${recipe.name}`}
                  disabled={disabled}
                  onClick={() =>
                    void mutate({
                      type: 'recipe.favorite',
                      data: { id: recipe.id, favorite: !recipe.favorite },
                    })
                  }
                >
                  <Heart size={17} fill={recipe.favorite ? 'currentColor' : 'none'} />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="default"
                onClick={() => openRecipe(recipe)}
                className="recipe-card-main"
              >
                <h2>{recipe.name}</h2>
                <p>{recipe.description || 'An easy addition to your weekly rotation.'}</p>
                <div className="recipe-card-tags">
                  <span>
                    <Clock3 size={13} />
                    {recipe.prepMinutes + recipe.cookMinutes} min
                  </span>
                  {recipe.tags.slice(0, 1).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </Button>
              <div className="recipe-card-bottom">
                <MacroLine nutrition={recipe.nutrition} />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`View ${recipe.name}`}
                  onClick={() => openRecipe(recipe)}
                >
                  <ArrowUpRight size={18} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="panel">
          <Empty
            icon={Search}
            title="Nothing in this corner yet"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setCategory('all');
                  setFavoritesOnly(false);
                }}
              >
                Clear filters
              </Button>
            }
          >
            Try another ingredient, or add a new recipe to your collection.
          </Empty>
        </Card>
      )}
      {!state && <ResourcePaging {...page.paging} />}
    </>
  );
}
