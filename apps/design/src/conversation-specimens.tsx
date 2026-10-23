import { useId, useRef, useState, type ReactNode } from "react";
import * as UI from "@packages/ui";
import { Check, FileText, Info, X } from "lucide-react";

// Current upstream Base UI examples adapted to explicit local-only data.
// https://ui.shadcn.com/docs/components/base/{attachment,bubble,code-block,marker,message,message-scroller,questionnaire,trace}
const questionItems = [
  {
    name: "focus",
    required: true,
    choices: [{ value: "strength" }, { value: "conditioning" }],
  },
  {
    name: "time",
    required: true,
    choices: [{ value: "short" }, { value: "long" }],
  },
] as const;
const initialMessages = Array.from({ length: 8 }, (_, index) => ({
  id: `sample-${index}`,
  text:
    index % 2
      ? "This is an illustrative reply. Plans remain separate from recorded work."
      : `Sample question ${index / 2 + 1}: can we plan a short session?`,
  author: index % 2 ? "Preview" : "Member",
}));

export function ConversationSpecimen({ id }: { id: string }) {
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState(
    "Illustrative content. No files, answers, or messages leave this app.",
  );
  const [lineNumbers, setLineNumbers] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const focusTitle = useId();
  const timeTitle = useId();
  let example: ReactNode;
  switch (id) {
    case "attachment":
      example = (
        <div className="specimen-stack">
          <UI.Label htmlFor="attachment-file">
            Choose a local sample file
          </UI.Label>
          <UI.Input
            id="attachment-file"
            ref={fileInput}
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <UI.Attachment state={file ? "done" : "idle"}>
            <UI.AttachmentMedia>
              <FileText />
            </UI.AttachmentMedia>
            <UI.AttachmentContent>
              <UI.AttachmentTitle>
                {file?.name ?? "No file selected"}
              </UI.AttachmentTitle>
              <UI.AttachmentDescription>
                {file
                  ? `${file.size.toLocaleString()} bytes · local preview only`
                  : "Choose a file to preview its metadata"}
              </UI.AttachmentDescription>
            </UI.AttachmentContent>
            {file && (
              <UI.AttachmentActions>
                <UI.AttachmentAction
                  aria-label="Remove selected sample file"
                  onClick={() => {
                    setFile(null);
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                >
                  <X />
                </UI.AttachmentAction>
              </UI.AttachmentActions>
            )}
          </UI.Attachment>
          <p className="specimen-note">
            Only filename and size are read. This specimen does not upload or
            inspect file contents.
          </p>
        </div>
      );
      break;
    case "bubble":
      example = (
        <UI.BubbleGroup>
          {(
            [
              "default",
              "secondary",
              "muted",
              "tinted",
              "outline",
              "ghost",
              "destructive",
            ] as const
          ).map((variant) => (
            <UI.Bubble key={variant} variant={variant}>
              <UI.BubbleContent>
                {variant === "destructive"
                  ? "Illustrative error: this sample could not be saved."
                  : `${variant[0].toUpperCase()}${variant.slice(1)} conversational content.`}
              </UI.BubbleContent>
            </UI.Bubble>
          ))}
        </UI.BubbleGroup>
      );
      break;
    case "code-block":
      example = (
        <div className="specimen-stack">
          <div className="specimen-row">
            <UI.Toggle
              pressed={lineNumbers}
              onPressedChange={setLineNumbers}
              aria-label="Show output line numbers"
            >
              Line numbers
            </UI.Toggle>
            <UI.Toggle
              pressed={wrap}
              onPressedChange={setWrap}
              aria-label="Wrap terminal output"
            >
              Wrap output
            </UI.Toggle>
          </div>
          <UI.CodeBlock>
            <UI.CodeBlockHeader>
              <UI.CodeBlockTitle>
                <FileText />
                Illustrative terminal output
              </UI.CodeBlockTitle>
            </UI.CodeBlockHeader>
            <UI.CodeBlockContent lineNumbers={lineNumbers} wrap={wrap}>
              {
                "Sample session import\n3 planned exercises read\n0 recorded sets changed\nPreview only: no database or application data has been modified."
              }
            </UI.CodeBlockContent>
            <UI.CodeBlockFooter>
              <span className="text-xs">
                Output specimen · not an executed command
              </span>
            </UI.CodeBlockFooter>
          </UI.CodeBlock>
        </div>
      );
      break;
    case "marker":
      example = (
        <div className="specimen-stack">
          <UI.Marker>
            <UI.MarkerIcon>
              <Info />
            </UI.MarkerIcon>
            <UI.MarkerContent>
              Illustrative conversation started
            </UI.MarkerContent>
          </UI.Marker>
          <UI.Marker variant="separator">
            <UI.MarkerContent>Today · sample separator</UI.MarkerContent>
          </UI.Marker>
          <UI.Marker variant="border">
            <UI.MarkerIcon>
              <Check />
            </UI.MarkerIcon>
            <UI.MarkerContent>Illustrative review complete</UI.MarkerContent>
          </UI.Marker>
        </div>
      );
      break;
    case "message":
      example = (
        <UI.MessageGroup>
          <UI.Message align="end">
            <UI.MessageAvatar>ME</UI.MessageAvatar>
            <UI.MessageContent>
              <UI.MessageHeader>Member · sample</UI.MessageHeader>
              <UI.Bubble>
                <UI.BubbleContent>
                  Can we make today’s session a little shorter?
                </UI.BubbleContent>
              </UI.Bubble>
              <UI.MessageFooter>10:42 · illustrative time</UI.MessageFooter>
            </UI.MessageContent>
          </UI.Message>
          <UI.Message>
            <UI.MessageAvatar>C</UI.MessageAvatar>
            <UI.MessageContent>
              <UI.MessageHeader>
                Corner · illustrative response
              </UI.MessageHeader>
              <UI.Bubble variant="muted">
                <UI.BubbleContent>
                  A shorter plan could retain the main lifts. No plan is changed
                  until you approve it.
                </UI.BubbleContent>
              </UI.Bubble>
              <UI.MessageFooter>No AI request is running.</UI.MessageFooter>
            </UI.MessageContent>
          </UI.Message>
        </UI.MessageGroup>
      );
      break;
    case "message-scroller":
      example = (
        <div className="specimen-stack">
          <div className="message-transcript">
            <UI.MessageScrollerProvider>
              <UI.MessageScroller>
                <UI.MessageScrollerViewport>
                  <UI.MessageScrollerContent className="p-4">
                    {messages.map((message) => (
                      <UI.MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={message.author === "Member"}
                      >
                        <UI.Message
                          align={message.author === "Member" ? "end" : "start"}
                        >
                          <UI.MessageContent>
                            <UI.MessageHeader>
                              {message.author}
                            </UI.MessageHeader>
                            <UI.Bubble
                              variant={
                                message.author === "Member"
                                  ? "default"
                                  : "muted"
                              }
                            >
                              <UI.BubbleContent>
                                {message.text}
                              </UI.BubbleContent>
                            </UI.Bubble>
                          </UI.MessageContent>
                        </UI.Message>
                      </UI.MessageScrollerItem>
                    ))}
                  </UI.MessageScrollerContent>
                </UI.MessageScrollerViewport>
                <UI.MessageScrollerButton aria-label="Scroll to latest sample message" />
              </UI.MessageScroller>
            </UI.MessageScrollerProvider>
          </div>
          <form
            className="specimen-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.trim()) return;
              setMessages((current) => [
                ...current,
                {
                  id: `local-${current.length}`,
                  text: draft.trim(),
                  author: "Member",
                },
              ]);
              setDraft("");
              setStatus(
                "Local sample message appended. No generated reply or network request.",
              );
            }}
          >
            <UI.Label htmlFor="sample-message">Append a local message</UI.Label>
            <UI.Input
              id="sample-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a preview message…"
            />
            <UI.Button type="submit" disabled={!draft.trim()}>
              Append sample
            </UI.Button>
          </form>
        </div>
      );
      break;
    case "questionnaire":
      example = submitted ? (
        <div className="specimen-stack">
          <UI.Alert>
            <UI.AlertTitle>Sample answers captured</UI.AlertTitle>
            <UI.AlertDescription>
              The selected answers are shown below. Nothing was sent to a
              server.
            </UI.AlertDescription>
          </UI.Alert>
          <UI.Button
            variant="outline"
            onClick={() => {
              setSubmitted(false);
              setStatus("Questionnaire reset.");
            }}
          >
            Start again
          </UI.Button>
        </div>
      ) : (
        <UI.Questionnaire
          className="max-w-lg"
          defaultItem="focus"
          items={questionItems}
          onSubmit={(event) => {
            event.preventDefault();
            const answers = new FormData(event.currentTarget);
            setStatus(
              `Focus: ${answers.get("focus") ?? "None"} · Time: ${answers.get("time") ?? "None"}. Local preview only.`,
            );
            setSubmitted(true);
          }}
        >
          <UI.QuestionnaireProgress />
          <UI.QuestionnaireItem
            name="focus"
            required
            aria-labelledby={focusTitle}
          >
            <UI.QuestionnaireTitle id={focusTitle}>
              What would you like to focus on?
            </UI.QuestionnaireTitle>
            <UI.QuestionnaireDescription>
              Choose one illustrative training focus.
            </UI.QuestionnaireDescription>
            <UI.QuestionnaireChoices>
              <UI.QuestionnaireChoice value="strength">
                Strength
                <UI.QuestionnaireChoiceDescription>
                  Practice the main lifts.
                </UI.QuestionnaireChoiceDescription>
              </UI.QuestionnaireChoice>
              <UI.QuestionnaireChoice value="conditioning">
                Conditioning
                <UI.QuestionnaireChoiceDescription>
                  Build a sustainable engine.
                </UI.QuestionnaireChoiceDescription>
              </UI.QuestionnaireChoice>
            </UI.QuestionnaireChoices>
            <UI.QuestionnaireError />
          </UI.QuestionnaireItem>
          <UI.QuestionnaireItem
            name="time"
            required
            aria-labelledby={timeTitle}
          >
            <UI.QuestionnaireTitle id={timeTitle}>
              How much time do you have?
            </UI.QuestionnaireTitle>
            <UI.QuestionnaireChoices>
              <UI.QuestionnaireChoice value="short">
                About 20 minutes
              </UI.QuestionnaireChoice>
              <UI.QuestionnaireChoice value="long">
                About 45 minutes
              </UI.QuestionnaireChoice>
            </UI.QuestionnaireChoices>
            <UI.QuestionnaireError />
          </UI.QuestionnaireItem>
          <UI.QuestionnaireActions>
            <UI.QuestionnairePrevious />
            <UI.QuestionnaireNext />
            <UI.QuestionnaireSubmit>Finish preview</UI.QuestionnaireSubmit>
          </UI.QuestionnaireActions>
        </UI.Questionnaire>
      );
      break;
    case "trace":
      example = (
        <UI.Trace>
          <UI.TraceLine>
            <UI.TraceIcon>
              <Check />
            </UI.TraceIcon>
            <UI.TraceTitle>Illustrative plan read</UI.TraceTitle>
            <UI.TraceDescription>5 exercises</UI.TraceDescription>
          </UI.TraceLine>
          <UI.TraceCollapsible>
            <UI.TraceCollapsibleTrigger>
              <UI.TraceLine>
                <UI.TraceIcon>
                  <Info />
                </UI.TraceIcon>
                <UI.TraceTitle>Review suggested changes</UI.TraceTitle>
              </UI.TraceLine>
            </UI.TraceCollapsibleTrigger>
            <UI.TraceCollapsibleContent>
              This sample would shorten accessory work. Recorded sets are not
              changed.
            </UI.TraceCollapsibleContent>
          </UI.TraceCollapsible>
          <UI.TraceLine status="pending">
            <UI.TraceIcon>
              <Info />
            </UI.TraceIcon>
            <UI.TraceTitle>
              Waiting for approval · illustrative state
            </UI.TraceTitle>
          </UI.TraceLine>
          <UI.TraceLine status="error">
            <UI.TraceIcon>
              <X />
            </UI.TraceIcon>
            <UI.TraceTitle>Illustrative validation error</UI.TraceTitle>
          </UI.TraceLine>
        </UI.Trace>
      );
      break;
    default:
      return null;
  }
  return (
    <section className="specimen-section">
      <div className="specimen-heading">
        <h2>Live preview</h2>
        <p>Conversation primitives using explicit local-only sample content.</p>
      </div>
      <div className="specimen-preview">
        {example}
        <p className="specimen-status" role="status">
          {status}
        </p>
      </div>
    </section>
  );
}
