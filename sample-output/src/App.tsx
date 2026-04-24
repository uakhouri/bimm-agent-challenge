import { Container, Typography, Box } from "@mui/material";
import CarList from "@/components/CarList";
import AddCarForm from "@/components/AddCarForm";

export default function App() {
  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Typography variant="h3" component="h1" gutterBottom>
        Car Inventory Manager
      </Typography>

      <Box sx={{ mb: 4 }}>
        <CarList />
      </Box>

      <AddCarForm />
    </Container>
  );
}
