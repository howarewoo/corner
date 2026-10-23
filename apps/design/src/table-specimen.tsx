import { useState } from "react";
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronDown } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@packages/ui";

// Adapted from the current shadcn Data Table recipe (TanStack Table v9):
// https://ui.shadcn.com/docs/components/base/data-table, retrieved 2026-10-23.
const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});
type SampleSession = {
  id: string;
  name: string;
  minutes: number;
  state: "Planned" | "Recorded";
};
const data: SampleSession[] = [
  { id: "one", name: "Upper body", minutes: 45, state: "Planned" },
  { id: "two", name: "Lower body", minutes: 40, state: "Recorded" },
  { id: "three", name: "Conditioning", minutes: 25, state: "Planned" },
  { id: "four", name: "Mobility", minutes: 15, state: "Recorded" },
  { id: "five", name: "Full body", minutes: 50, state: "Planned" },
];
const helper = createColumnHelper<typeof features, SampleSession>();
const columns = helper.columns([
  helper.display({
    id: "select",
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all visible sessions"
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={
          table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()
        }
        onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked)}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        aria-label={`Select ${row.original.name}`}
        checked={row.getIsSelected()}
        onCheckedChange={(checked) => row.toggleSelected(checked)}
      />
    ),
    enableSorting: false,
    enableHiding: false,
  }),
  helper.accessor("name", {
    header: ({ column }) => (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Session <ArrowUpDown size={14} />
      </Button>
    ),
    cell: ({ row }) => row.getValue("name"),
  }),
  helper.accessor("minutes", {
    header: "Minutes",
    cell: ({ row }) => row.getValue("minutes"),
  }),
  helper.accessor("state", {
    header: "State",
    cell: ({ row }) => (
      <Badge variant="secondary">{row.getValue("state")}</Badge>
    ),
  }),
]);

export function DataTableSpecimen() {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] =
    useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = useState({});
  const table = useTable({
    features,
    data,
    columns,
    getRowId: (row) => row.id,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: { sorting, columnFilters, columnVisibility, rowSelection },
    initialState: { pagination: { pageSize: 3, pageIndex: 0 } },
  });
  return (
    <section className="specimen-section">
      <div className="specimen-heading">
        <h2>Sessions · illustrative data</h2>
        <p>Filter, sort, select rows, hide columns, and change pages.</p>
      </div>
      <div className="specimen-preview specimen-stack">
        <div className="specimen-row">
          <Input
            className="max-w-sm"
            aria-label="Filter sample sessions"
            placeholder="Filter sessions…"
            value={(table.getColumn("name")?.getFilterValue() as string) ?? ""}
            onChange={(event) =>
              table.getColumn("name")?.setFilterValue(event.target.value)
            }
          />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              Columns <ChevronDown size={14} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(checked) =>
                      column.toggleVisibility(checked)
                    }
                  >
                    {column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Table>
          <caption className="sr-only">Illustrative training sessions</caption>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {!header.isPlaceholder && (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length}>
                  No sessions match.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="specimen-row">
          <p className="specimen-note" role="status">
            {table.getFilteredSelectedRowModel().rows.length} of{" "}
            {table.getFilteredRowModel().rows.length} matching sessions selected
            · Page {table.state.pagination.pageIndex + 1} of{" "}
            {Math.max(1, table.getPageCount())}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            Previous page
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            Next page
          </Button>
        </div>
      </div>
    </section>
  );
}
