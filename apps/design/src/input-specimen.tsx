// Live examples adapted from https://ui.shadcn.com/docs/components/base/input.
import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { Info } from 'lucide-react';
import {
  Badge,
  Button,
  ButtonGroup,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@packages/ui';
import { Section, Status } from './specimen-layout';

const countries = [
  { label: 'United States', value: 'us' },
  { label: 'United Kingdom', value: 'uk' },
  { label: 'Canada', value: 'ca' },
];
const languages = [
  { label: 'العربية', value: 'ar' },
  { label: 'עברית', value: 'he' },
  { label: 'English', value: 'en' },
];
const translations = {
  ar: {
    dir: 'rtl',
    label: 'مفتاح API',
    description: 'مثال محلي فقط. لا يتم إرسال المفتاح أو حفظه.',
  },
  he: { dir: 'rtl', label: 'מפתח API', description: 'דוגמה מקומית בלבד. המפתח אינו נשלח או נשמר.' },
  en: {
    dir: 'ltr',
    label: 'API key',
    description: 'Local example only. The key is not sent or saved.',
  },
} as const;

export function InputExamples() {
  const [groupResult, setGroupResult] = useState(
    'Submit a sample name and email; nothing leaves this preview.',
  );
  const [inlineResult, setInlineResult] = useState(
    'Search the local samples: Upper body, Recovery, Long run.',
  );
  const [searchResult, setSearchResult] = useState(
    'Search the local samples: Upper body, Recovery, Long run.',
  );
  const [requiredResult, setRequiredResult] = useState(
    'Submit to try native required-field validation.',
  );
  const [formResult, setFormResult] = useState(
    'Synthetic contact details only. Nothing is sent or saved.',
  );
  const groupForm = useForm({
    defaultValues: { name: '', email: '' },
    onSubmit: ({ value }) =>
      setGroupResult(
        `Local submission: ${value.name} (${value.email}). Nothing was sent or saved.`,
      ),
  });
  const inlineForm = useForm({
    defaultValues: { query: '' },
    onSubmit: ({ value }) => setInlineResult(search(value.query)),
  });
  const searchForm = useForm({
    defaultValues: { query: '' },
    onSubmit: ({ value }) => setSearchResult(search(value.query)),
  });
  const requiredForm = useForm({
    defaultValues: { required: '' },
    onSubmit: () =>
      setRequiredResult('Required value accepted locally. Nothing was sent or saved.'),
  });
  const contactForm = useForm({
    defaultValues: { name: '', email: '', phone: '', country: 'us' as string | null, address: '' },
    onSubmit: ({ value }) => {
      const countryLabel =
        countries.find((item) => item.value === value.country)?.label ?? 'No country';
      setFormResult(
        `Local submission for ${value.name} in ${countryLabel}. Nothing was sent or saved.`,
      );
    },
  });
  const [language, setLanguage] = useState<keyof typeof translations>('ar');
  const translated = translations[language];

  function search(value: string) {
    const query = value.trim();
    const matches = ['Upper body', 'Recovery', 'Long run'].filter((name) =>
      name.toLowerCase().includes(query.toLowerCase()),
    );
    return query
      ? matches.length
        ? `Local matches: ${matches.join(', ')}.`
        : `No local samples match “${query}”.`
      : 'Enter a search term to find a local sample.';
  }

  return (
    <>
      <Section
        title="API key"
        description="The default documented example, using a masked password input. Use a synthetic key only."
      >
        <div className="specimen-narrow">
          <Field>
            <FieldLabel htmlFor="input-demo-api-key">API key</FieldLabel>
            <Input
              id="input-demo-api-key"
              type="password"
              placeholder="sk-example…"
              autoComplete="off"
              aria-describedby="input-demo-api-key-description"
            />
            <FieldDescription id="input-demo-api-key-description">
              Local example only. The key is not sent or saved.
            </FieldDescription>
          </Field>
        </div>
      </Section>
      <Section title="Basic">
        <div className="specimen-narrow">
          <Input id="input-basic" aria-label="Basic text input" placeholder="Enter text" />
        </div>
      </Section>
      <Section title="Field">
        <div className="specimen-narrow">
          <Field>
            <FieldLabel htmlFor="input-field-username">Username</FieldLabel>
            <Input
              id="input-field-username"
              placeholder="Enter your username"
              aria-describedby="input-field-username-description"
            />
            <FieldDescription id="input-field-username-description">
              Choose a sample username for this preview.
            </FieldDescription>
          </Field>
        </div>
      </Section>
      <Section title="Field Group">
        <form
          className="specimen-narrow specimen-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void groupForm.handleSubmit();
          }}
          onReset={(event) => {
            event.preventDefault();
            groupForm.reset();
            setGroupResult('Sample fields reset. Nothing was sent or saved.');
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="input-fieldgroup-name">Name</FieldLabel>
              <groupForm.Field name="name">
                {(field) => (
                  <Input
                    id="input-fieldgroup-name"
                    name={field.name}
                    placeholder="Jordan Lee"
                    required
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </groupForm.Field>
            </Field>
            <Field>
              <FieldLabel htmlFor="input-fieldgroup-email">Email</FieldLabel>
              <groupForm.Field name="email">
                {(field) => (
                  <Input
                    id="input-fieldgroup-email"
                    name="email"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    type="email"
                    placeholder="name@example.com"
                    required
                    aria-describedby="input-fieldgroup-email-description"
                  />
                )}
              </groupForm.Field>
              <FieldDescription id="input-fieldgroup-email-description">
                Use a synthetic address. No email will be sent.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Button type="reset" variant="outline">
                Reset
              </Button>
              <Button type="submit">Submit</Button>
            </Field>
          </FieldGroup>
          <Status>{groupResult}</Status>
        </form>
      </Section>
      <Section title="Disabled">
        <div className="specimen-narrow">
          <Field data-disabled="true">
            <FieldLabel htmlFor="input-demo-disabled">Email</FieldLabel>
            <Input
              id="input-demo-disabled"
              type="email"
              placeholder="Email"
              disabled
              aria-describedby="input-disabled-description"
            />
            <FieldDescription id="input-disabled-description">
              This field is currently disabled.
            </FieldDescription>
          </Field>
        </div>
      </Section>
      <Section title="Invalid">
        <div className="specimen-narrow">
          <Field data-invalid="true">
            <FieldLabel htmlFor="input-invalid">Sample email with an error</FieldLabel>
            <Input
              id="input-invalid"
              defaultValue="not-an-email"
              aria-invalid="true"
              aria-describedby="input-invalid-description"
            />
            <FieldDescription id="input-invalid-description">
              Illustrative error state: enter an address such as name@example.com.
            </FieldDescription>
          </Field>
        </div>
      </Section>
      <Section title="File">
        <div className="specimen-narrow">
          <Field>
            <FieldLabel htmlFor="input-picture">Picture</FieldLabel>
            <Input
              id="input-picture"
              type="file"
              accept="image/*"
              aria-describedby="input-picture-description"
            />
            <FieldDescription id="input-picture-description">
              Select a local picture. The browser displays its filename; this preview does not
              upload it.
            </FieldDescription>
          </Field>
        </div>
      </Section>
      <Section title="Inline">
        <form
          className="specimen-narrow specimen-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void inlineForm.handleSubmit();
          }}
        >
          <FieldLabel htmlFor="input-inline-search">Search sample sessions</FieldLabel>
          <Field orientation="horizontal">
            <inlineForm.Field name="query">
              {(field) => (
                <Input
                  id="input-inline-search"
                  name="query"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  type="search"
                  placeholder="Search…"
                  aria-describedby="input-inline-result"
                />
              )}
            </inlineForm.Field>
            <Button type="submit">Search</Button>
          </Field>
          <div id="input-inline-result">
            <Status>{inlineResult}</Status>
          </div>
        </form>
      </Section>
      <Section title="Grid">
        <FieldGroup className="specimen-grid">
          <Field>
            <FieldLabel htmlFor="input-grid-first-name">First name</FieldLabel>
            <Input id="input-grid-first-name" placeholder="Jordan" />
          </Field>
          <Field>
            <FieldLabel htmlFor="input-grid-last-name">Last name</FieldLabel>
            <Input id="input-grid-last-name" placeholder="Lee" />
          </Field>
        </FieldGroup>
      </Section>
      <Section title="Required">
        <form
          className="specimen-narrow specimen-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void requiredForm.handleSubmit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="input-required">
              Required field <span aria-hidden="true">*</span>
            </FieldLabel>
            <requiredForm.Field name="required">
              {(field) => (
                <Input
                  id="input-required"
                  name="required"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="This field is required"
                  required
                  aria-describedby="input-required-description"
                />
              )}
            </requiredForm.Field>
            <FieldDescription id="input-required-description">
              This field must be filled out before submitting.
            </FieldDescription>
          </Field>
          <div className="specimen-row">
            <Button type="submit">Validate</Button>
          </div>
          <Status>{requiredResult}</Status>
        </form>
      </Section>
      <Section title="Badge">
        <div className="specimen-narrow">
          <Field>
            <FieldLabel htmlFor="input-badge">
              Webhook URL <Badge variant="secondary">Beta</Badge>
            </FieldLabel>
            <Input id="input-badge" type="url" placeholder="https://api.example.com/webhook" />
          </Field>
        </div>
      </Section>
      <Section title="Input Group">
        <div className="specimen-narrow">
          <Field>
            <FieldLabel htmlFor="input-group-url">Website URL</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="input-group-url"
                placeholder="example.com"
                aria-describedby="input-group-url-description"
              />
              <InputGroupAddon>
                <InputGroupText>https://</InputGroupText>
              </InputGroupAddon>
              <InputGroupAddon align="inline-end">
                <Info aria-hidden="true" />
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription id="input-group-url-description">
              Enter a sample domain; this preview does not open the website.
            </FieldDescription>
          </Field>
        </div>
      </Section>
      <Section title="Button Group">
        <form
          className="specimen-narrow specimen-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void searchForm.handleSubmit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="input-button-group">Search</FieldLabel>
            <ButtonGroup>
              <searchForm.Field name="query">
                {(field) => (
                  <Input
                    id="input-button-group"
                    name="query"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    type="search"
                    placeholder="Type to search…"
                    aria-describedby="input-button-group-result"
                  />
                )}
              </searchForm.Field>
              <Button type="submit" variant="outline">
                Search
              </Button>
            </ButtonGroup>
          </Field>
          <div id="input-button-group-result">
            <Status>{searchResult}</Status>
          </div>
        </form>
      </Section>
      <Section
        title="Form"
        description="A complete local form with native validation and a country select."
      >
        <form
          className="specimen-narrow specimen-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void contactForm.handleSubmit();
          }}
          onReset={(event) => {
            event.preventDefault();
            contactForm.reset();
            setFormResult('Form cancelled and reset. Nothing was sent or saved.');
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="input-form-name">
                Name <span aria-hidden="true">*</span>
              </FieldLabel>
              <contactForm.Field name="name">
                {(field) => (
                  <Input
                    id="input-form-name"
                    name={field.name}
                    placeholder="Jordan Lee"
                    required
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </contactForm.Field>
            </Field>
            <Field>
              <FieldLabel htmlFor="input-form-email">Email</FieldLabel>
              <contactForm.Field name="email">
                {(field) => (
                  <Input
                    id="input-form-email"
                    name="email"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    type="email"
                    placeholder="jordan@example.com"
                    aria-describedby="input-form-email-description"
                  />
                )}
              </contactForm.Field>
              <FieldDescription id="input-form-email-description">
                Use synthetic contact details for this local preview.
              </FieldDescription>
            </Field>
            <div className="specimen-grid">
              <Field>
                <FieldLabel htmlFor="input-form-phone">Phone</FieldLabel>
                <contactForm.Field name="phone">
                  {(field) => (
                    <Input
                      id="input-form-phone"
                      name="phone"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                      onBlur={field.handleBlur}
                      type="tel"
                      placeholder="+1 (555) 123-4567"
                    />
                  )}
                </contactForm.Field>
              </Field>
              <Field>
                <FieldLabel htmlFor="input-form-country">Country</FieldLabel>
                <contactForm.Field name="country">
                  {(field) => (
                    <Select
                      items={countries}
                      value={field.state.value}
                      onValueChange={field.handleChange}
                    >
                      <SelectTrigger id="input-form-country">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {countries.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </contactForm.Field>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="input-form-address">Address</FieldLabel>
              <contactForm.Field name="address">
                {(field) => (
                  <Input
                    id="input-form-address"
                    name={field.name}
                    placeholder="123 Main St"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </contactForm.Field>
            </Field>
            <Field orientation="horizontal">
              <Button type="reset" variant="outline">
                Cancel
              </Button>
              <Button type="submit">Submit</Button>
            </Field>
          </FieldGroup>
          <Status>{formResult}</Status>
        </form>
      </Section>
      <Section
        title="RTL"
        description="Switch between Arabic, Hebrew, and English to compare direction and translated labels."
      >
        <div className="specimen-narrow specimen-stack">
          <Field>
            <FieldLabel htmlFor="input-rtl-language">Example language</FieldLabel>
            <Select
              items={languages}
              value={language}
              onValueChange={(value) => {
                if (value === 'ar' || value === 'he' || value === 'en') setLanguage(value);
              }}
            >
              <SelectTrigger id="input-rtl-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languages.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field dir={translated.dir} lang={language}>
            <FieldLabel htmlFor="input-rtl-api-key">{translated.label}</FieldLabel>
            <Input
              id="input-rtl-api-key"
              type="password"
              placeholder="sk-example…"
              dir={translated.dir}
              autoComplete="off"
              aria-describedby="input-rtl-description"
            />
            <FieldDescription id="input-rtl-description" className="text-start">
              {translated.description}
            </FieldDescription>
          </Field>
        </div>
      </Section>
    </>
  );
}
