import { FormControl, InputLabel, Select, MenuItem, SelectChangeEvent } from "@mui/material";

export type SortOption = "year" | "make";

interface SortSelectorProps {
  value: SortOption;
  onChange: (value: SortOption) => void;
}

export default function SortSelector({ value, onChange }: SortSelectorProps) {
  const handleChange = (event: SelectChangeEvent) => {
    onChange(event.target.value as SortOption);
  };

  return (
    <FormControl fullWidth>
      <InputLabel id="sort-selector-label">Sort By</InputLabel>
      <Select
        labelId="sort-selector-label"
        id="sort-selector"
        value={value}
        label="Sort By"
        onChange={handleChange}
      >
        <MenuItem value="year">Year (Newest First)</MenuItem>
        <MenuItem value="make">Make (A-Z)</MenuItem>
      </Select>
    </FormControl>
  );
}
