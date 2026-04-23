# Car Inventory Manager

A single-page application for browsing a small inventory of cars. The application reads car records from a mocked GraphQL API, displays them as cards, lets the user search and sort the list, and lets the user add new cars through a form.

## Data

Each car has the following fields:

- A unique identifier
- Make (e.g. "Toyota")
- Model (e.g. "Camry")
- Model year (a four-digit integer)
- Exterior color
- Three image URLs, one for each viewport size: mobile, tablet, and desktop

The mock GraphQL API and the five seed cars it serves are already configured in the boilerplate. The relevant GraphQL operations — a query that returns all cars, a query that returns a single car by ID, and a mutation that adds a new car — are already defined in `src/graphql/queries.ts` and the boilerplate's MSW handlers already respond to them. The application should import and use these existing operations rather than redefining them.

## Screens and Behavior

There is one screen. It shows the following, top to bottom:

### Title

A heading identifying the application as a car inventory manager.

### Controls

A horizontal row of controls that lets the user filter and sort the list below:

- A search input that filters the list by model name. Matching is case-insensitive and partial (typing "cam" should match "Camry").
- A sort selector with two options: sort by model year (newest first) and sort by make (alphabetical).

Filter and sort are applied together — the user sees the list that results from applying the current search term and then applying the current sort order.

### Car List

Below the controls, a grid of cards — one card per car in the filtered, sorted list. Each card shows:

- The car's image, chosen based on the current viewport width:
  - Mobile image when the viewport is 640px wide or narrower
  - Tablet image when the viewport is between 641px and 1023px inclusive
  - Desktop image when the viewport is 1024px wide or wider
- The make, model, and model year, displayed together as a readable heading (e.g. "2024 Toyota Camry")
- The exterior color, displayed below the heading

If the underlying query is still loading, the list area shows a loading indicator. If the query fails, the list area shows an error message.

### Add Car Form

Below the car list, a form that lets the user add a new car. The form has four fields:

- Make (text input, required)
- Model (text input, required)
- Year (numeric input, required, must be a valid four-digit year)
- Color (text input, required)

Submitting the form calls the GraphQL mutation that adds a car. After a successful submission, the form clears and the newly added car appears in the list without requiring a page reload.

If the submission fails, the form shows an error and keeps the user's entered values so they can retry.

## Styling

The application uses Material UI for all visual components — cards, text inputs, buttons, typography, and loading/error indicators. It does not introduce additional CSS-in-JS libraries or custom theming beyond what the boilerplate already provides. The overall layout is responsive: it works on mobile, tablet, and desktop viewports without horizontal scrolling.

## Code Organization

GraphQL data access is extracted into a custom React hook. Any component that needs the list of cars or needs to add a car uses the hook rather than calling Apollo directly.

Components are small and single-purpose. The card, the search input, the sort selector, and the add-car form are each their own component.

## Testing

Unit tests exist for the most important behaviors:

- The card renders the car's make, model, year, and color.
- The search input filters the list as the user types.
- The add-car form submits the mutation with the entered values.

Tests use Apollo's `MockedProvider` pattern and include `__typename` on mocked response data for Apollo cache compatibility. This pattern is demonstrated in the boilerplate's existing test file.

## What Is Already Set Up

The following pieces are already in place in the boilerplate and should not be re-created by the generated code:

- React, TypeScript, Vite, Material UI, Apollo Client, MSW, and Vitest are configured.
- The `Car` TypeScript type is defined in `src/types.ts`.
- The Apollo client, GraphQL operations, MSW handlers, and five seed cars are set up.
- A reference component at `src/components/Example.tsx` and a reference test at `src/__tests__/Example.test.tsx` demonstrate the expected style, import conventions (`@/` alias), and testing pattern.

The generated code should match the conventions visible in those reference files.