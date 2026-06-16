using System.Text.Json;
using Azure.Messaging.ServiceBus;

namespace Awaver.Backend.Services;

public sealed class AzureServiceBusFrameQueue(ServiceBusSender sender) : IFrameQueue
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task EnqueueAsync(FrameQueueMessage message, CancellationToken cancellationToken)
    {
        var serviceBusMessage = new ServiceBusMessage(JsonSerializer.Serialize(message, JsonOptions))
        {
            ContentType = "application/json",
            SessionId = message.SessionId.ToString(),
            MessageId = $"{message.SessionId}:{message.SequenceNo}",
        };

        await sender.SendMessageAsync(serviceBusMessage, cancellationToken);
    }
}
