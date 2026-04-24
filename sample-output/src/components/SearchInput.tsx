import { TextField } from "@mui/material";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
}

export default function SearchInput({ value, onChange }: SearchInputProps) {
  return (
    <TextField
      label="Search by model"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      fullWidth
      variant="outlined"
    />
  );
}
